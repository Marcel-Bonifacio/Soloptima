# Project finance module

`src/finance.cpp` builds an annual after-tax cash flow. Year 0 is construction/COD; years 1..T are operation, taken from the simulated energy and costs of each project year (degradation, battery replacements, fuel escalation and load growth are already in the simulation).

## Ownership structures

| Structure | Revenue | Typical use |
|---|---|---|
| Host-owned | Avoided diesel cost: fuel + genset O&M + carbon cost of the diesel-only case, minus what remains with the hybrid | The plant owner invests in PV/BESS for its own site |
| Single owner (PPA) | Tariff × billed renewable energy | IPP selling to PLN or to an industrial offtaker |
| Third-party ownership | As PPA for the developer, plus the host's view: diesel-only cost vs tariff (incl. VAT) + remaining diesel cost − shortfall penalty | Captive lease / BOO of PV + BESS at a diesel-fired site |

## Year-by-year calculation

```
E_t       = renewable kWh delivered to the site load (simulation: served to the site, auxiliaries excluded, × RE fraction)
ACE_t     = ace_factor × E_1 × (1 − PV degradation)^(t−1)                      contracted energy
billed_t  = max(E_t, ToP × ACE_t) + deemed_share × curtailed_t
tariff_t  = scale × [ Σ fixed components c (stage(t)) × (1+idx_c)^(t−1)  +  Σ adders pct_a × Σ fixed ]
            or scale × (1 − discount) × diesel-only (fuel + genset O&M) cost per kWh
revenue_t = tariff_t × billed_t − penalty_rate × tariff_t × max(0, threshold × ACE_t − E_t)
opex_t    = simulated PV/BESS/wind O&M + replacements + (fixed opex + land lease) × esc^(t−1) + insurance% × hard capex × esc^(t−1)
EBITDA_t  = revenue_t − opex_t
taxable_t = EBITDA_t − depreciation_t − interest_t − losses brought forward (expiry after N years; 0 = unlimited, −1 = none)
tax_t     = rate_t × max(0, taxable_t)        rate_t = 0 in a tax holiday or for a host owner that pays no income tax; Art. 31E: rate × (1 − 0.5 × min(1, threshold_low / turnover)) when turnover ≤ threshold_high
cash tax  = max(0, tax_t − withholding_t)     withholding = wht% × revenue, creditable, excess not refunded
CFADS_t   = EBITDA_t − withholding_t − cash tax_t − ΔWC_t (+ VAT refund in year 1 when recoverable)
esc       = 1 + O&M escalation (Costs)
```

**Capital cost.**
- Hard capex is PV + BESS + wind + development margin, taken from the simulation. Genset capex is excluded, also when new gensets are costed, because it is the same with and without the plant.
- Total installed cost (TIC) = hard + contingency + development (fixed) + land + VAT on capex + IDC + upfront fee + DSRA funding.
- IDC = debt × rate × ½ × construction years (average drawn balance).

**Depreciation.**
- Applied separately to the main assets and the battery.
- Methods: straight line, or declining balance at 2/life switching to straight line.
- Financing costs are capitalised into the main asset class.
- Land and recoverable VAT are not depreciated.
- Presets cover Indonesian fiscal groups 2/3/4 (8/16/20 years, 25/12.5/10 % DB).

**Debt.**
- Sizing:
  - gearing × TIC;
  - DSCR capacity = Σ_k (CFADS_{grace+k} / DSCR_target) / (1+r)^k;
  - or the lower of the two.
- An optional P90/P50 revenue haircut applies to the sizing case: CFADS_sizing,t = CFADS_t − (1 − f) × revenue_t in every year. The inter-annual variability run (Solar resource) can set f from the spread of the revenue itself over historical weather years ([MANUAL.md](MANUAL.md), *Inter-annual variability and P50/P90*).
- Repayment:
  - Sculpted: DS_t = CFADS_t / DSCR_target × debt / capacity.
  - Annuity, or equal principal.
  - Interest-only grace period.
  - The tenor is capped at the analysed term, and the balance is fully repaid at the end of the tenor.
- DSRA = next year's debt service × months/12. It is funded at COD and released when the loan is repaid.
- Interest, tax, CFADS, sculpting, IDC and fees depend on each other, so they are solved by fixed-point iteration (8 passes), with no circular spreadsheet references.

## Returns

| Metric | Definition |
|---|---|
| Project IRR / NPV | Unlevered, after tax (tax computed without interest), on −(hard + contingency + dev + land + VAT) at t = 0. NPV at the project discount rate, with t = 0 undiscounted. |
| Equity IRR / NPV | −(TIC − debt) at t = 0, then CFADS − debt service − ΔDSRA, plus terminal value. NPV at the cost of equity. |
| Payback | Interpolated year when the cumulative cash flow turns positive. |
| DSCR | CFADS / debt service. Minimum and average over the tenor. |
| LLCR | PV of CFADS over the tenor at the loan rate, divided by debt. |
| LPPA (nominal / real) | PV(revenue) / PV(billed energy). Revenue is discounted at the nominal rate n. Energy is discounted at n for the nominal value and at the real rate (1 + n)/(1 + i) − 1 for the real value. |
| LCOE (nominal / real) | PV(capex + opex − recoverable VAT refunded in year 1 − terminal value) / PV(delivered energy), discounted as for LPPA. Unlevered and pre-tax. |
| PLN-style levelised tariff | Annuity of the tariff series, as in PLN evaluation forms. Not energy-weighted. |
| Tariff solving | Bisection on a multiplier of the tariff so that the equity (or project) IRR equals the target. |
| Host savings | Σ(diesel-only cost − cost with the plant) / Σ diesel-only cost, and its NPV. |

## Lessons from two industry financial models

Two industry financial models were studied: a captive PV + BESS solar lease to an industrial host that keeps its gensets, and a PV + BESS IPP selling to the state utility under a staged tariff.

Taken over:
- third-party ownership with a host savings view;
- take-or-pay, and a contracted-energy profile with a shortfall threshold;
- tariff VAT, creditable withholding and the Art. 31E facility;
- staged multi-component tariffs with % adders;
- IDC and fees in total investment cost;
- a P90 haircut for debt sizing;
- receivable days, and a levelised tariff output in the utility's style;
- insurance as % of capex, and fixed staff and office opex.

Spreadsheet errors seen in these models and avoided here:
- **Broken formulas:** an interest formula that refers to a text cell, so the equity IRR and NPV show `#VALUE!`.
- **Incomplete capex:** a project phase left out of the equity cash flow and of depreciation.
- **Inconsistent tax:** levered and unlevered tax computed with different rates and credits.
- **NPV over-discounting:** year 0 discounted one period too many.
- **Mislabelled metrics:** a "levelised tariff" that is undiscounted ΣRev/ΣkWh, and a DSCR on pre-tax EBITDA rather than CFADS.
- **Tax gaps:** no loss carry-forward, and withholding refunds that produce positive tax in later years.
- **Depreciation:** straight line on total capex, including land and VAT.
- **Double counting:** contingency counted three times.
- **Stale links:** a consolidation sheet using its own stale inputs, and hard-coded year-1 values.

## Presets

Presets are starting points. Check every value against the term sheet.

| Preset | Main values |
|---|---|
| Generic | 25 % tax, 70 % gearing at 8 % / 12 yr, DSCR 1.30 sculpted, 6-month DSRA, 0.5 % insurance |
| Indonesia PLN IPP (PV + BESS) | PPA 20 yr; A 0.085/0.035, B 0.025, E = 30 %·(A+B), F = 60 %·(A+B), stage 2 from year 11; 22 % CIT, 2 % WHT, Art. 31E (IDR 4.8 bn / 50 bn); group-4 DB depreciation, battery 8 yr; 70 % at 7.4 %, 10 yr, DSCR 1.20; 2 % fee; 11 % VAT capitalised; 0.9 % insurance; 60 receivable days; transfer at end |
| Captive lease to industrial host | Third-party; 0.15/kWh + 1.5 %/yr; 90 % ToP; 11 % VAT on tariff; 22 % CIT, 2 % WHT, 31E; 70 % at 10 %, 10 yr equal principal; 0.3 % insurance; transfer at end |
| Tariff at a discount to diesel | Third-party; tariff = 75 % of the diesel-only fuel + O&M cost per kWh (follows fuel escalation); 90 % ToP |
