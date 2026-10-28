// PV and load forecasting: several methods behind one interface, all causal (a forecast issued at hour
// `issue` only uses observations up to issue-1). The weather/load year is treated as cyclic, so a forecast
// in early January sees the previous December - consistent with a multi-year simulation of a repeating year.
//
// Most methods work on a normalised index y = actual / reference:
//   PV   -> reference = clear-sky PV output, so y is the clear-sky index (removes the daily sun shape)
//   load -> reference = mean load, so y is load relative to its average
// and the forecast is y_hat(tgt) x reference(tgt).
#pragma once
#include "model.hpp"
#include <memory>
#include <string>
#include <vector>

struct MethodInfo { std::string id, name, description; };
const std::vector<MethodInfo>& pv_forecast_methods();
const std::vector<MethodInfo>& load_forecast_methods();

class SeriesForecaster {
public:
    // ref empty -> load series (reference = mean). noise_sigma is used by "noisy", seed by "noisy" and "mlp".
    SeriesForecaster(const std::string& method, const std::vector<double>& act, const std::vector<double>& ref,
                     double noise_sigma, unsigned seed);
    double operator()(int issue, int tgt) const;   // forecast in the units of `act`

private:
    std::string method_;
    bool pv_;
    double sigma_;
    std::vector<double> act_, ref_, y_, yff_, cum_act_, cum_ref_, lev_, s30a_, s30r_, z_;
    std::vector<double> theta_;           // RLS coefficients snapshot per day x bucket x feature
    std::vector<unsigned char> analog_;   // per issue: day-lags (1..60) sorted by pattern distance
    std::vector<std::unique_ptr<SeriesForecaster>> members_;   // ensemble
    std::vector<double> cum_err_intra_, cum_err_day_;          // ensemble: per member prefix sums of squared error
    std::vector<std::vector<double>> mlp_;                     // neural network weights, one snapshot per month

    double base(const std::string& m, int issue, int tgt) const;
    double ratio(int a, int b) const;             // sum(act)/sum(ref) over [a, b), NaN when no reference
    void features(int issue, int tgt, double* x) const;
    void build_ets();
    void build_rls();
    void build_analog();
    void build_ensemble(unsigned seed);
    void build_mlp(unsigned seed);
    void mlp_inputs(int issue, int tgt, double* in) const;
};

// PV, load and wind forecasters used by the EMS (PV and load skill is also reported in the results).
class Forecaster {
public:
    Forecaster(const EmsParams& m, const std::vector<double>& pv_act, const std::vector<double>& pv_cs,
               const std::vector<double>& load, const std::vector<double>& wind = {});
    double pv(int issue, int tgt) const { return pv_(issue, tgt); }     // kW per kWp
    double load(int issue, int tgt) const { return load_(issue, tgt); } // kW (base year)
    double wind(int issue, int tgt) const { return wind_ ? (*wind_)(issue, tgt) : 0.0; }   // kW per turbine

private:
    SeriesForecaster pv_, load_;
    std::unique_ptr<SeriesForecaster> wind_;
};
