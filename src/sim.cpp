#include "sim.hpp"
#include "ems.hpp"
#include "fuel.hpp"
#include "pv.hpp"
#include <algorithm>
#include <memory>
#include <cmath>

namespace {

double npv_of(const std::vector<double>& cf, double r) {
    double v = 0;
    for (size_t y = 0; y < cf.size(); ++y) v += cf[y] / std::pow(1 + r, double(y));
    return v;
}

// Year-1 forecast skill (independent of the dispatch strategy, so it is always reported).
void forecast_stats(const Project& p, const Forecaster& fc, const std::vector<double>& pv, double kwp, SimResult& R) {
    double e_pv1 = 0, e_pvd = 0, b_pvd = 0, s_pv = 0, e_l1 = 0, e_ld = 0, b_ld = 0, s_l = 0;
    Hourly& h = R.hourly;
    for (int t = 0; t < HOURS; ++t) {
        const double pa = pv[t] * kwp, la = p.load_kw[t];
        const double p1 = fc.pv(t, t) * kwp, pd = fc.pv(t - 24, t) * kwp;
        const double l1 = fc.load(t, t), ld = fc.load(t - 24, t);
        e_pv1 += std::fabs(p1 - pa); e_pvd += std::fabs(pd - pa); b_pvd += pd - pa; s_pv += pa;
        e_l1 += std::fabs(l1 - la); e_ld += std::fabs(ld - la); b_ld += ld - la; s_l += la;
        h.pv_fc_h1[t] = p1; h.pv_fc_da[t] = pd; h.load_fc_h1[t] = l1; h.load_fc_da[t] = ld;
    }
    ForecastStats& f = R.fc;
    if (s_pv > 0) { f.pv_nmae_h1 = e_pv1 / s_pv; f.pv_nmae_da = e_pvd / s_pv; f.pv_bias_da = b_pvd / s_pv; }
    if (s_l > 0) { f.load_nmae_h1 = e_l1 / s_l; f.load_nmae_da = e_ld / s_l; f.load_bias_da = b_ld / s_l; }
}

} // namespace

double aux_kw(const Project& p, const Sizing& s, double tamb) {
    const AuxParams& a = p.aux;
    const bool has_bess = s.bess_kwh > 1e-6 && s.bess_kw > 1e-6;
    // HVAC/BMS by nameplate energy, PCS no-load by PCS rating. The PCS part counts in every hour, also with battery flow
    // (the aux array feeds unit commitment before dispatch), so there it overlaps slightly with the round-trip efficiency.
    const double bess = has_bess ? s.bess_kwh / 1000 * a.bess_kw_per_mwh * (1 + a.bess_temp_coeff * std::max(0.0, tamb - a.ref_c)) +
                                       s.bess_kw / 1000 * a.pcs_kw_per_mw
                                 : 0.0;
    // Plant auxiliaries with any new asset; each step-up transformer's no-load only with the asset it serves.
    const bool has_pv = s.pv_kwp > 0, plant_on = has_pv || has_bess || s.wind_units > 0.5;
    const double plant = (plant_on ? a.plant_kw : 0.0) + (has_pv ? a.trafo_noload_kw : 0.0) + (has_bess ? a.bess_trafo_noload_kw : 0.0);
    return bess + plant;
}

SimResult simulate(const Project& p, const std::vector<double>& pv_per_kwp, const std::vector<double>& pv_cs_per_kwp,
                   const Sizing& s, bool keep_hourly, const Forecaster* shared_fc) {
    SimResult R;
    R.size = s;
    const DieselParams& dg = p.dg;
    const BessParams& bp = p.bess;
    const EconParams& ec = p.econ;
    const EmsParams& em = p.ems;
    const FuelTable fuel(dg);

    const bool has_bess = s.bess_kwh > 1e-6 && s.bess_kw > 1e-6;
    const bool cc = dg.strategy == "cycle_charging";
    const bool pred = dg.strategy == "predictive" && has_bess;
    const int min_on = dg.units > 0 ? std::min(dg.min_units_online, dg.units) : 0;
    const double Pr = dg.unit_kw;

    const int N = ec.lifetime;
    const int sim_years = p.sim.all_years ? N : 1;
    const bool has_wind = s.wind_units > 0.5;
    const std::vector<double> wind_pt = has_wind ? wind_per_turbine(p) : std::vector<double>();
    double soh = has_bess ? bp.soh_init : 1.0;
    double E = has_bess ? s.bess_kwh * bp.soc_init : 0.0;    // stored energy (kWh)
    int prev_units = 0;
    bool cc_hold = false;   // cycle charging: gensets are charging the battery toward the setpoint, so it holds its energy

    // Auxiliary load by local hour (ambient shifted to local time as in the PV model). It does not grow with the load.
    std::vector<double> aux(HOURS, 0.0);
    const LocalShift sh = local_shift(p);
    for (int i = 0; i < HOURS; ++i) put_local(aux, i, aux_kw(p, s, p.wx.tamb.size() == HOURS ? p.wx.tamb[i] : 25.0), sh);

    std::unique_ptr<Forecaster> own_fc;
    if (!shared_fc && (pred || keep_hourly))
        own_fc = std::make_unique<Forecaster>(em, pv_per_kwp, pv_cs_per_kwp.size() == HOURS ? pv_cs_per_kwp : pv_per_kwp, p.load_kw, wind_pt);
    const Forecaster* fcp = shared_fc ? shared_fc : own_fc.get();
    Planner planner(dg, fuel);
    PlanInput pin = plan_input(p, fuel);
    const double eta = pin.eta;
    std::vector<double> E_traj, lfc(em.horizon), pfc(em.horizon);
    std::vector<int> u_plan;
    const int replan = std::min(em.replan, em.horizon);   // the plan covers only `horizon` hours

    if (keep_hourly) {
        Hourly& h = R.hourly;
        for (auto* v : {&h.load, &h.aux, &h.pv_avail, &h.pv_to_load, &h.pv_to_bess, &h.pv_curtailed, &h.bess_dis, &h.gen_to_bess,
                        &h.gen_to_load, &h.gen_dump, &h.gen_units, &h.fuel_l, &h.unmet, &h.soc, &h.soc_target,
                        &h.wind_avail, &h.wind_to_load, &h.wind_to_bess, &h.wind_curtailed,
                        &h.pv_fc_h1, &h.load_fc_h1, &h.pv_fc_da, &h.load_fc_da})
            v->assign(HOURS, 0.0);
        R.has_hourly = true;
        forecast_stats(p, *fcp, pv_per_kwp, s.pv_kwp, R);
    }

    // Battery ageing over year Y: calendar fade plus cycle fade. Cycles are counted at the cells (DC) against the
    // cycle life at its rated depth of discharge. Replacement at the threshold (not in the last year).
    const double soh_repl = bp.replace_soh >= 0 ? bp.replace_soh : bp.eol_soh;
    auto age_bess = [&](YearResult& Y) {
        Y.soh_loss_cal = bp.calendar_fade;
        Y.soh_loss_cyc = Y.bess_efc_dc * (1.0 - bp.eol_soh) / std::max(1.0, bp.cycle_life * bp.cycle_life_dod);
        soh -= Y.soh_loss_cal + Y.soh_loss_cyc;
        if (soh <= soh_repl && Y.year < N) { Y.bess_replaced = true; soh = 1.0; }
    };

    for (int y = 1; y <= sim_years; ++y) {
        YearResult Y;
        Y.year = y;
        Y.bess_soh = soh;
        const double load_scale = std::pow(1 + p.sim.load_growth, y - 1);
        const double pv_scale = s.pv_kwp * std::pow(1 - p.pv.degradation, y - 1);
        const double Enom = has_bess ? s.bess_kwh * soh : 0.0;
        const double Emin = Enom * bp.soc_min, Emax = Enom * bp.soc_max, Esp = std::min(Emax, Enom * std::max(bp.soc_min, dg.cc_setpoint));
        const double Pb = has_bess ? s.bess_kw : 0.0;
        E = std::clamp(E, Emin, Emax);
        Y.e_start = E;
        const bool rec = keep_hourly && y == 1;
        pin.Emin = Emin; pin.Emax = Emax; pin.Pb = Pb;
        int plan_t0 = -1000000;   // battery capacity changed: re-plan
        double peak_b = 0.0;      // highest battery charge or discharge power this year
        int lol_run = 0, low_run = 0;   // current runs of loss-of-load and low-load hours
        double aux_unmet = 0.0;         // auxiliary energy left unserved once the whole site load is unmet

        for (int t = 0; t < HOURS; ++t) {
            const double L = p.load_kw[t] * load_scale + aux[t];
            // Variable renewables are dispatched together (PV + wind); flows are split back pro rata for reporting.
            const double Psol = pv_per_kwp[t] * pv_scale;
            const double Pwnd = has_wind ? wind_pt[t] * s.wind_units : 0.0;
            const double Ppv = Psol + Pwnd;
            const double fpv = Ppv > 0 ? Psol / Ppv : 1.0;
            if (has_bess && bp.self_discharge > 0) { const double l = E * bp.self_discharge; E -= l; Y.self_discharge += l; }

            const double dis_cap = std::min(Pb, std::max(0.0, E - Emin) * eta);
            const double ch_cap = std::min(Pb, std::max(0.0, Emax - E) / eta);
            // Battery power that counts as spinning reserve: what it can sustain for reserve_duration_h from the stored energy.
            const double res_cap = std::min(Pb, std::max(0.0, E - Emin) * eta / bp.reserve_duration_h);

            // --- Control layer: how far the battery may discharge, how much the gensets should charge ---
            double dis_limit = dis_cap, want_gch = 0.0, soc_tgt = 0.0, b_plan = 0.0;
            int u_floor = 0, u_tgt = 0;
            if (pred) {
                if (t - plan_t0 >= replan) {
                    for (int j = 0; j < em.horizon; ++j) {
                        lfc[j] = fcp->load(t, t + j) * load_scale + aux[(t + j) % HOURS];   // auxiliary load taken as known
                        pfc[j] = fcp->pv(t, t + j) * pv_scale + (has_wind ? fcp->wind(t, t + j) * s.wind_units : 0.0);
                    }
                    planner.plan(pin, E, lfc, pfc, E_traj, u_plan);
                    plan_t0 = t;
                    if (y == 1) R.fc.plans++;
                }
                const int j = t - plan_t0;
                const double E_tgt = E_traj[j + 1];
                soc_tgt = Enom > 0 ? E_tgt / Enom : 0.0;
                b_plan = E > E_tgt ? (E - E_tgt) * eta : -(E_tgt - E) / eta;
                const double err = (L - Ppv) - (lfc[j] - pfc[j]);
                if (y == 1) R.fc.net_error_kwh += std::fabs(err);
                if (b_plan >= 0) dis_limit = std::min(dis_cap, b_plan);
                else { dis_limit = 0.0; want_gch = std::max(0.0, std::min(ch_cap, -b_plan) - std::max(0.0, Ppv - L)); }
                u_tgt = u_plan[j];
                if (em.firm_commitment) u_floor = u_tgt;
            } else if (cc) {
                // Once genset charging has begun, the battery does not discharge in place of genset output until it reaches
                // the setpoint (it still covers what the gensets cannot). Without this hold the battery would be topped up in
                // one hour and emptied in the next, losing 1 - RTE of the energy on every round trip. Units are committed as
                // if the battery were held; the hour in which the setpoint is reached is shared below.
                // A rounding remainder above the minimum SOC counts as empty.
                want_gch = std::max(0.0, Esp - E) / eta;
                if (cc_hold || E - Emin <= 1e-6 * Enom) dis_limit = 0.0;
            }

            // --- Unit commitment: residual deficit + planned charging + spinning reserve ---
            const double pv_load0 = std::min(Ppv, L);
            const double r0 = L - pv_load0;
            const double reserve = dg.reserve_load * L + dg.reserve_pv * pv_load0;
            auto units_for = [&](double dlim, double wg) {
                const double dis_use = std::min(r0, dlim);
                const double bess_res = bp.provides_reserve ? std::max(0.0, res_cap - dis_use) : 0.0;
                const double need = (r0 - dis_use) + (pred ? wg : 0.0) + std::max(0.0, reserve - bess_res);
                int n = need > 1e-6 ? int(std::ceil(need / Pr - 1e-9)) : 0;
                return std::min(std::max({n, min_on, u_floor}), dg.units);
            };
            int u = units_for(dis_limit, want_gch);
            if (pred && u > u_tgt) {
                // Real-time compensation: the forecast error would force an unplanned genset start.
                // Diesel marginal fuel is almost flat, so the battery only steps in to avoid that start:
                // first drop planned genset charging, then discharge just enough to stay on the planned units.
                if (units_for(dis_limit, 0.0) <= u_tgt) {
                    double lo = 0, hi = want_gch;
                    for (int it = 0; it < 30; ++it) { double mid = 0.5 * (lo + hi); (units_for(dis_limit, mid) <= u_tgt ? lo : hi) = mid; }
                    want_gch = lo;
                } else if (units_for(dis_cap, 0.0) <= u_tgt) {
                    want_gch = 0.0;
                    double lo = dis_limit, hi = dis_cap;
                    for (int it = 0; it < 30; ++it) { double mid = 0.5 * (lo + hi); (units_for(mid, 0.0) <= u_tgt ? hi : lo) = mid; }
                    dis_limit = hi;
                }
                u = units_for(dis_limit, want_gch);
            }
            const double gmin = u * Pr * dg.min_load, gmax = u * Pr;

            // Cycle charging shares the hour at either end of a charge, so results do not jump by whole hours: a hold that
            // reaches the setpoint part way through the hour frees the battery for the rest of it (here), and a battery that
            // runs empty part way through is charged for the rest of it (charging step).
            const double c_idle = cc ? std::min(Pb, std::max(0.0, Ppv + gmax - L)) : 0.0;   // charging power while the battery is idle
            double dis_frac = 1.0;                                                          // share of the hour it may discharge in
            if (cc && cc_hold && c_idle > want_gch) {
                dis_frac = 1.0 - want_gch / c_idle;
                dis_limit = std::min(dis_frac * Pb, std::max(0.0, Esp - Emin) * eta);
            }

            // --- Allocation: genset minimum (must run) -> PV -> BESS -> genset above minimum -> BESS reserve ---
            double g_load = std::min(gmin, L);
            const double g_excess = gmin - g_load;
            double rem = L - g_load;
            const double pv_load = std::min(Ppv, rem);
            rem -= pv_load;
            double surplus = Ppv - pv_load;
            const double deficit = rem;   // what the battery is asked to cover before gensets go above minimum
            double dis = std::min(rem * dis_frac, dis_limit);
            rem -= dis;
            const double gx = std::min(rem, gmax - gmin);
            g_load += gx;
            rem -= gx;
            if (rem > 0) { const double extra = std::min(rem, std::max(0.0, dis_cap - dis)); dis += extra; rem -= extra; }
            const double unmet = std::max(0.0, rem);

            // --- Charging: PV surplus first, then unavoidable genset excess, then deliberate genset charging ---
            const double pv_ch = std::min(surplus, ch_cap);
            surplus -= pv_ch;
            double g_ch = std::min(g_excess, ch_cap - pv_ch);
            const double dump = g_excess - g_ch;
            double g_delib = 0.0;   // deliberate genset charging from the headroom of the online units
            // Cycle charging: share of the hour the battery spent discharging when it ran empty within it (1 otherwise).
            const double t_dis = cc && !cc_hold && dis > 0 && E - dis / eta <= Emin + 1e-6 * Enom ? dis / std::min(Pb, deficit) : 1.0;
            if (u > 0 && ((want_gch > 0 && (dis <= 0 || (cc && cc_hold))) || t_dis < 1.0)) {
                const double room = t_dis < 1.0 ? std::min((1.0 - t_dis) * c_idle, (Esp - (E - dis / eta)) / eta) - pv_ch - g_ch
                                                : std::min(ch_cap - pv_ch - g_ch, want_gch - (cc ? pv_ch : 0.0) - g_ch);
                const double head = gmax - (g_load + g_excess);
                g_delib = std::max(0.0, std::min(room, head));
                g_ch += g_delib;
            }
            const double E_top = E + (pv_ch + g_ch) * eta;   // after charging, before any discharge in the same hour
            E += (pv_ch + g_ch) * eta - dis / eta;
            E = std::clamp(E, 0.0, std::max(Emax, 0.0));
            if (cc) cc_hold = (cc_hold || g_delib > 0) && (cc_hold ? E_top : E) < Esp - 1e-6 * Enom;
            if (pred && y == 1) R.fc.bess_compensation_kwh += std::fabs((dis - pv_ch - g_ch) - b_plan);

            const double gen = g_load + g_ch + dump;
            const double fuel_l = u > 0 ? u * Pr * fuel(gen / gmax) : 0.0;

            // --- Operational adequacy: spinning reserve left after allocation (genset charging can be interrupted) against
            // the load step plus the renewable power the load loses when PV + wind drop by reserve_pv. Curtailed and
            // charging power absorbs that drop first, so gensets held at minimum loading are not counted short.
            const double head_g = gmax - (g_load + dump);
            const double head_b = bp.provides_reserve ? std::max(0.0, res_cap - dis) : 0.0;
            const double re_drop = std::max(0.0, pv_load - (1 - dg.reserve_pv) * Ppv);
            const double short_kw = std::max(0.0, dg.reserve_load * L + re_drop - head_g - head_b);
            if (short_kw > 1e-3 * L) { Y.reserve_short_h += 1; Y.reserve_short_max_kw = std::max(Y.reserve_short_max_kw, short_kw); }
            const bool lol = unmet > 1e-3 * L, low = u > 0 && gen <= gmin + 1e-6;
            lol_run = lol ? lol_run + 1 : 0;
            low_run = low ? low_run + 1 : 0;
            if (lol) { Y.lol_h += 1; if (lol_run == 1) Y.lol_events += 1; Y.lol_max_h = std::max(Y.lol_max_h, double(lol_run)); }
            if (low) { Y.minload_h += 1; Y.minload_run_max_h = std::max(Y.minload_run_max_h, double(low_run)); }
            Y.max_units = std::max(Y.max_units, double(u));
            if (u > 0 && u == dg.units) Y.fleet_full_h += 1;
            if (y > 1 || t > 0) Y.max_starts_h = std::max(Y.max_starts_h, double(u - prev_units));   // not the initial start

            Y.load += L;
            Y.aux += aux[t];
            Y.unmet += unmet;
            aux_unmet += std::max(0.0, unmet - (L - aux[t]));
            Y.max_unmet_kw = std::max(Y.max_unmet_kw, unmet);
            Y.pv_avail += Psol;
            Y.pv_to_load += pv_load * fpv;
            Y.pv_to_bess += pv_ch * fpv;
            Y.pv_curtailed += surplus * fpv;
            Y.wind_avail += Pwnd;
            Y.wind_used += (pv_load + pv_ch) * (1 - fpv);
            Y.wind_curtailed += surplus * (1 - fpv);
            Y.wind_to_load += pv_load * (1 - fpv);
            Y.wind_to_bess += pv_ch * (1 - fpv);
            Y.re_avail += Ppv;
            Y.re_direct += pv_load0;
            Y.bess_dis += dis;
            Y.bess_ch += pv_ch + g_ch;
            peak_b = std::max(peak_b, std::max(dis, pv_ch + g_ch));
            Y.gen_kwh += gen;
            Y.gen_to_load += g_load;
            Y.gen_to_bess += g_ch;
            Y.gen_dump += dump;
            Y.fuel_l += fuel_l;
            Y.unit_hours += u;
            if (u > prev_units) Y.starts += u - prev_units;
            prev_units = u;

            if (rec) {
                Hourly& h = R.hourly;
                h.load[t] = L; h.aux[t] = aux[t]; h.pv_avail[t] = Psol; h.pv_to_load[t] = pv_load * fpv; h.pv_to_bess[t] = pv_ch * fpv;
                h.pv_curtailed[t] = surplus * fpv; h.wind_avail[t] = Pwnd; h.wind_to_load[t] = pv_load * (1 - fpv); h.wind_to_bess[t] = pv_ch * (1 - fpv);
                h.wind_curtailed[t] = surplus * (1 - fpv); h.bess_dis[t] = dis; h.gen_to_bess[t] = g_ch; h.gen_to_load[t] = g_load;
                h.gen_dump[t] = dump; h.gen_units[t] = u; h.fuel_l[t] = fuel_l; h.unmet[t] = unmet;
                h.soc[t] = Enom > 0 ? E / Enom : 0.0;
                h.soc_target[t] = soc_tgt;
            }
        }

        Y.e_end = E;
        Y.served = Y.load - Y.unmet;
        Y.served_site = Y.served - (Y.aux - aux_unmet);   // unmet energy is attributed to the site load first
        Y.re_fraction = Y.served > 0 ? std::clamp(1.0 - (Y.gen_kwh - Y.gen_dump) / Y.served, 0.0, 1.0) : 0.0;
        Y.co2_t = Y.fuel_l * ec.co2_kg_per_l / 1000.0;
        Y.nox_t = Y.fuel_l * ec.nox_g_per_l / 1e6;
        Y.sox_t = Y.fuel_l * ec.sox_g_per_l / 1e6;
        if (has_bess) {
            Y.bess_efc = Y.bess_dis / s.bess_kwh;
            Y.bess_efc_dc = Y.bess_dis / (eta * s.bess_kwh);
            Y.max_c_rate = peak_b / s.bess_kwh;
            age_bess(Y);
        }
        R.years.push_back(Y);
    }

    // Fast mode: repeat year 1 energy flows (cycles, C-rate, stored energy and adequacy counts included), but still age the
    // battery year by year.
    for (int y = sim_years + 1; y <= N; ++y) {
        YearResult Y = R.years[0];
        Y.year = y;
        Y.bess_soh = soh;
        Y.bess_replaced = false;
        if (has_bess) age_bess(Y);
        R.years.push_back(Y);
    }

    // --- Economics ---
    Economics& e = R.econ;
    const double inv_kwac = s.pv_kwp / p.pv.dc_ac_ratio;
    e.capex_pv = s.pv_kwp * ec.pv_capex_kwp;
    e.capex_bess = has_bess ? s.bess_kwh * ec.bess_capex_kwh + s.bess_kw * ec.bess_capex_kw : 0.0;
    const double wind_kw = has_wind ? s.wind_units * p.wind.rated_kw : 0.0;
    e.capex_wind = wind_kw * ec.wind_capex_kw;
    e.capex_diesel = ec.diesel_capex_kw * dg.unit_kw * dg.units;
    e.capex_other = (e.capex_pv + e.capex_bess + e.capex_wind) * ec.other_capex_frac;
    e.capex_total = e.capex_pv + e.capex_bess + e.capex_wind + e.capex_diesel + e.capex_other;

    const double d = ec.discount_rate;
    double npc = e.capex_total, disc_energy = 0;
    double last_bess_cost = e.capex_bess;
    double soh0 = bp.soh_init;   // SOH the battery in service was installed at
    for (auto& Y : R.years) {
        const int y = Y.year;
        const double esc_f = std::pow(1 + ec.fuel_escalation, y - 1);
        const double esc_o = std::pow(1 + ec.om_escalation, y - 1);
        Y.c_fuel = Y.fuel_l * ec.fuel_price * esc_f;
        Y.c_om_new = (s.pv_kwp * ec.pv_om_kwp + wind_kw * ec.wind_om_kw + (has_bess ? s.bess_kwh * ec.bess_om_kwh : 0.0)) * esc_o;
        Y.c_om_dg = (Y.gen_kwh * ec.diesel_om_kwh + Y.unit_hours * ec.diesel_om_unit_hour) * esc_o;
        Y.c_om = Y.c_om_new + Y.c_om_dg;
        Y.c_carbon = Y.co2_t * ec.carbon_price_t;
        if (y == ec.inverter_replacement_year && s.pv_kwp > 0 && y < N) Y.c_replace += inv_kwac * ec.inverter_replacement_kwac;
        if (has_wind && ec.wind_life >= 1 && y % int(ec.wind_life) == 0 && y < N) Y.c_replace += e.capex_wind;
        if (Y.bess_replaced) {
            const double cost = s.bess_kwh * ec.bess_replace_kwh * std::pow(1 - ec.bess_cost_decline, y);
            Y.c_replace += cost;
            last_bess_cost = cost;
            soh0 = 1.0;
            R.bess_replacements++;
        }
        if (y == N) {
            // Linear salvage of remaining life: battery by state of health above the replacement threshold (against the SOH it
            // was installed at), PV and wind by calendar life.
            if (has_bess && soh0 > soh_repl) Y.c_salvage -= last_bess_cost * std::clamp((soh - soh_repl) / (soh0 - soh_repl), 0.0, 1.0);
            if (ec.pv_life > N) Y.c_salvage -= e.capex_pv * (ec.pv_life - N) / ec.pv_life;
            if (has_wind && ec.wind_life >= 1) {
                const double used = std::fmod(double(N), ec.wind_life);
                if (used > 0) Y.c_salvage -= e.capex_wind * (ec.wind_life - used) / ec.wind_life;
            }
        }
        Y.c_total = Y.c_fuel + Y.c_om + Y.c_carbon + Y.c_replace + Y.c_salvage;
        const double df = std::pow(1 + d, y);
        npc += Y.c_total / df;
        disc_energy += Y.served_site / df;
    }
    e.npc = npc;
    e.lcoe = disc_energy > 0 ? npc / disc_energy : 0.0;
    // Annualised view used in the sizing literature: TAC = NPC x CRF(i, N), COE = TAC / annual energy served to the site.
    e.crf = d > 0 ? d * std::pow(1 + d, N) / (std::pow(1 + d, N) - 1) : 1.0 / N;
    e.tac = npc * e.crf;
    e.coe = R.years[0].served_site > 0 ? e.tac / R.years[0].served_site : 0.0;

    const YearResult& Y1 = R.years[0];
    R.re_fraction = Y1.re_fraction;
    R.unmet_fraction = Y1.load > 0 ? Y1.unmet / Y1.load : 0.0;
    for (const auto& Y : R.years) if (Y.load > 0) R.unmet_fraction_max = std::max(R.unmet_fraction_max, Y.unmet / Y.load);
    R.curtail_fraction = Y1.re_avail > 0 ? (Y1.pv_curtailed + Y1.wind_curtailed) / Y1.re_avail : 0.0;
    auto& m = R.metrics;
    m.lpsp = R.unmet_fraction;                                               // loss of power supply probability (energy basis)
    m.ssci = Y1.re_avail > 0 ? Y1.re_direct / Y1.re_avail : 0.0;            // self-sufficiency (consumption) index
    m.sssi = Y1.load > 0 ? Y1.re_direct / Y1.load : 0.0;                    // self-sufficiency (supply) index
    m.rep = 100.0 * (1.0 - m.lpsp);                                          // reliability (%)
    m.excess_kwh = Y1.pv_curtailed + Y1.wind_curtailed + Y1.gen_dump;
    m.excess_fraction = Y1.load > 0 ? m.excess_kwh / Y1.load : 0.0;
    m.co2_t = Y1.co2_t; m.nox_kg = Y1.nox_t * 1000; m.sox_kg = Y1.sox_t * 1000;
    m.jobs = ec.jobs_pv_per_mw * s.pv_kwp / 1000 + ec.jobs_wind_per_mw * wind_kw / 1000 + ec.jobs_bess_per_mwh * s.bess_kwh / 1000;
    if (ec.population > 0) {
        // HDI vs per-capita electricity (Dufo-Lopez 2016 form used by Abdoulaye et al.): energy in kWh per person per year
        const double e_pc = (Y1.served_site + std::min(m.excess_kwh, 0.75 * Y1.served_site)) / ec.population;
        m.hdi = e_pc > 0 ? 0.0978 * std::log(e_pc) - 0.0319 : 0.0;
    }
    R.fuel_l_y1 = Y1.fuel_l;
    R.avg_gen_load = Y1.unit_hours > 0 ? Y1.gen_kwh / (Y1.unit_hours * Pr) : 0.0;
    return R;
}

Comparison compare(const SimResult& h, const SimResult& b) {
    Comparison c;
    c.lcoe_base = b.econ.lcoe;
    c.npv_savings = b.econ.npc - h.econ.npc;
    c.fuel_saved_l_y1 = b.fuel_l_y1 - h.fuel_l_y1;
    c.co2_saved_t_y1 = b.years[0].co2_t - h.years[0].co2_t;

    // Incremental cash flow of investing in the hybrid instead of the reference system.
    std::vector<double> cf(h.years.size() + 1, 0.0);
    cf[0] = -(h.econ.capex_total - b.econ.capex_total);
    for (size_t i = 0; i < h.years.size(); ++i) cf[i + 1] = b.years[i].c_total - h.years[i].c_total;

    double cum = cf[0];
    c.payback_years = -1;
    for (size_t y = 1; y < cf.size(); ++y) {
        double prev = cum;
        cum += cf[y];
        if (prev < 0 && cum >= 0) { c.payback_years = (y - 1) + (-prev) / cf[y]; break; }
    }
    if (cf[0] >= 0) c.payback_years = 0;

    // IRR by bisection on [-0.99, 10]
    double lo = -0.99, hi = 10.0, flo = npv_of(cf, lo), fhi = npv_of(cf, hi);
    if (cf[0] < 0 && flo * fhi < 0) {
        for (int it = 0; it < 200; ++it) {
            const double mid = 0.5 * (lo + hi);
            if (mid == lo || mid == hi) break;   // interval cannot shrink further
            const double fm = npv_of(cf, mid);
            if ((fm > 0) == (flo > 0)) { lo = mid; flo = fm; } else hi = mid;
        }
        c.irr = 0.5 * (lo + hi);
        c.irr_valid = true;
    }
    return c;
}

json::Value result_to_json(const SimResult& r, bool include_hourly) {
    using json::Value;
    Value o = Value::object();
    o["size"] = Value(json::Object{{"pv_kwp", r.size.pv_kwp}, {"bess_kwh", r.size.bess_kwh}, {"bess_kw", r.size.bess_kw}, {"wind_units", r.size.wind_units}});
    const auto& mt = r.metrics;
    o["metrics"] = Value(json::Object{{"lpsp", mt.lpsp}, {"ssci", mt.ssci}, {"sssi", mt.sssi}, {"rep", mt.rep}, {"excess_kwh", mt.excess_kwh},
                                      {"excess_fraction", mt.excess_fraction}, {"co2_t", mt.co2_t}, {"nox_kg", mt.nox_kg}, {"sox_kg", mt.sox_kg},
                                      {"jobs", mt.jobs}, {"hdi", mt.hdi >= 0 ? Value(mt.hdi) : Value()}});
    o["re_fraction"] = r.re_fraction;
    o["unmet_fraction"] = r.unmet_fraction;
    o["unmet_fraction_max"] = r.unmet_fraction_max;
    o["curtail_fraction"] = r.curtail_fraction;
    o["fuel_l_y1"] = r.fuel_l_y1;
    o["avg_gen_load"] = r.avg_gen_load;
    o["bess_replacements"] = r.bess_replacements;
    const Economics& e = r.econ;
    o["econ"] = Value(json::Object{{"capex_pv", e.capex_pv}, {"capex_bess", e.capex_bess}, {"capex_wind", e.capex_wind}, {"capex_diesel", e.capex_diesel},
                                   {"crf", e.crf}, {"tac", e.tac}, {"coe", e.coe},
                                   {"capex_other", e.capex_other}, {"capex_total", e.capex_total}, {"npc", e.npc},
                                   {"lcoe", e.lcoe}});
    Value years = Value::array();
    for (const auto& Y : r.years) {
        years.push(Value(json::Object{
            {"year", Y.year}, {"load", Y.load}, {"served", Y.served}, {"unmet", Y.unmet}, {"aux", Y.aux}, {"served_site", Y.served_site},
            {"pv_avail", Y.pv_avail},
            {"pv_to_load", Y.pv_to_load}, {"pv_to_bess", Y.pv_to_bess}, {"pv_curtailed", Y.pv_curtailed},
            {"bess_dis", Y.bess_dis}, {"bess_ch", Y.bess_ch}, {"bess_soh", Y.bess_soh}, {"bess_efc", Y.bess_efc},
            {"bess_efc_dc", Y.bess_efc_dc}, {"soh_loss_cal", Y.soh_loss_cal}, {"soh_loss_cyc", Y.soh_loss_cyc}, {"max_c_rate", Y.max_c_rate},
            {"bess_replaced", Y.bess_replaced}, {"gen_kwh", Y.gen_kwh}, {"gen_to_load", Y.gen_to_load}, {"gen_to_bess", Y.gen_to_bess},
            {"gen_dump", Y.gen_dump}, {"e_start", Y.e_start}, {"e_end", Y.e_end}, {"fuel_l", Y.fuel_l}, {"unit_hours", Y.unit_hours}, {"starts", Y.starts},
            {"max_unmet_kw", Y.max_unmet_kw}, {"lol_h", Y.lol_h}, {"lol_events", Y.lol_events}, {"lol_max_h", Y.lol_max_h},
            {"reserve_short_h", Y.reserve_short_h}, {"reserve_short_max_kw", Y.reserve_short_max_kw}, {"max_units", Y.max_units},
            {"fleet_full_h", Y.fleet_full_h}, {"minload_h", Y.minload_h}, {"minload_run_max_h", Y.minload_run_max_h},
            {"max_starts_h", Y.max_starts_h}, {"re_fraction", Y.re_fraction}, {"co2_t", Y.co2_t}, {"nox_t", Y.nox_t}, {"sox_t", Y.sox_t},
            {"wind_avail", Y.wind_avail}, {"wind_used", Y.wind_used}, {"wind_to_load", Y.wind_to_load}, {"wind_to_bess", Y.wind_to_bess},
            {"wind_curtailed", Y.wind_curtailed}, {"self_discharge", Y.self_discharge},
            {"c_fuel", Y.c_fuel}, {"c_om", Y.c_om}, {"c_om_new", Y.c_om_new}, {"c_om_dg", Y.c_om_dg}, {"c_replace", Y.c_replace}, {"c_carbon", Y.c_carbon},
            {"c_salvage", Y.c_salvage}, {"c_total", Y.c_total}}));
    }
    o["years"] = years;
    if (include_hourly && r.has_hourly) {
        const Hourly& h = r.hourly;
        o["hourly"] = Value(json::Object{
            {"load", Value(h.load)}, {"aux", Value(h.aux)}, {"pv_avail", Value(h.pv_avail)}, {"pv_to_load", Value(h.pv_to_load)},
            {"pv_to_bess", Value(h.pv_to_bess)}, {"pv_curtailed", Value(h.pv_curtailed)}, {"bess_dis", Value(h.bess_dis)},
            {"gen_to_bess", Value(h.gen_to_bess)}, {"gen_to_load", Value(h.gen_to_load)}, {"gen_dump", Value(h.gen_dump)},
            {"gen_units", Value(h.gen_units)}, {"fuel_l", Value(h.fuel_l)}, {"unmet", Value(h.unmet)}, {"soc", Value(h.soc)},
            {"soc_target", Value(h.soc_target)}, {"wind_avail", Value(h.wind_avail)}, {"wind_to_load", Value(h.wind_to_load)},
            {"wind_to_bess", Value(h.wind_to_bess)},
            {"wind_curtailed", Value(h.wind_curtailed)}, {"pv_fc_h1", Value(h.pv_fc_h1)}, {"load_fc_h1", Value(h.load_fc_h1)},
            {"pv_fc_da", Value(h.pv_fc_da)}, {"load_fc_da", Value(h.load_fc_da)}});
    }
    const ForecastStats& f = r.fc;
    o["forecast"] = Value(json::Object{{"pv_nmae_h1", f.pv_nmae_h1}, {"pv_nmae_da", f.pv_nmae_da},
                                       {"load_nmae_h1", f.load_nmae_h1}, {"load_nmae_da", f.load_nmae_da},
                                       {"pv_bias_da", f.pv_bias_da}, {"load_bias_da", f.load_bias_da},
                                       {"net_error_kwh", f.net_error_kwh}, {"bess_compensation_kwh", f.bess_compensation_kwh},
                                       {"plans", f.plans}});
    return o;
}

json::Value comparison_to_json(const Comparison& c) {
    return json::Value(json::Object{{"npv_savings", c.npv_savings},
                                    {"irr", c.irr_valid ? json::Value(c.irr) : json::Value()},
                                    {"payback_years", c.payback_years >= 0 ? json::Value(c.payback_years) : json::Value()},
                                    {"fuel_saved_l_y1", c.fuel_saved_l_y1},
                                    {"co2_saved_t_y1", c.co2_saved_t_y1},
                                    {"lcoe_base", c.lcoe_base}});
}
