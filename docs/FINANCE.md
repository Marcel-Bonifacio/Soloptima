# Project finance module

`engine/src/finance/` builds an annual after-tax cash flow. Year 0 is construction/COD; years 1..T are operation, taken from the simulated energy and costs of each project year (degradation, battery replacements, fuel escalation and load growth are already in the simulation).

Inside the annual model the loan can be paid semi-annually, quarterly or monthly (`debt.rs`), the loan or the tariff can be in another currency on an exchange rate path (`fx.rs`), and a partnership flip can split the equity between a tax equity investor and a sponsor (`flip.rs`). With their defaults (yearly debt, no other currency, another structure) every result is the annual model's to the byte.

## Ownership structures

| Structure | Revenue | Typical use |
|---|---|---|
| Host-owned | Avoided diesel cost: fuel + genset O&M + carbon cost of the diesel-only case, minus what remains with the hybrid | The plant owner invests in PV/BESS for its own site |
| Single owner (PPA) | Tariff × billed renewable energy | IPP selling to PLN or to an industrial offtaker |
| Third-party ownership | As PPA for the developer, plus the host's view: diesel-only cost vs tariff (incl. VAT) + remaining diesel cost − shortfall penalty | Captive lease / BOO of PV + BESS at a diesel-fired site |
| Partnership flip | As PPA, owned by a partnership of a tax equity investor and a sponsor that share cash, taxable income and tax credits, with a flip of the shares | Projects whose sponsor cannot use the tax losses and credits itself |

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

## Debt periods

With debt paid every half-year, quarter or month (m = 2, 4 or 12 periods a year) the loan is scheduled period by period, and each year of the cash flow takes the sums of its periods.

```
i            = r / m                                                   nominal annual rate over the periods
CFADS_p      = CFADS_t × w_j                                           period j of year t; w_j = Σ monthly weights of its months / Σ all 12
capacity     = Σ_k (CFADS_sizing,grace·m+k / DSCR_target) / (1 + i)^k  over the m × (tenor − grace) repayment periods
DS_p         = interest_p + principal_p,   interest_p = i × balance_p
  sculpted     DS_p = CFADS_sizing,p / DSCR_target × debt / capacity
  annuity      DS_p = debt × i / (1 − (1 + i)^−n)
  equal        principal_p = debt / n
DSCR_p       = CFADS_p / DS_p                                          the lowest is reported beside the yearly minimum
DSRA_t       = Σ DS of the next (months × m / 12) periods after year t, a fraction of a period pro rata
IDC          = debt × i × (N + 1) / 2                                  N = m × construction years
```

- The monthly weights spread each year's CFADS from January to December (the simulated year), for a seasonal cash flow; blank spreads it evenly. With sculpting the period cover stays at the target; with an annuity or equal principal a weak season shows as a lower period cover.
- Interest during construction: the loan is drawn in N equal parts at the start of each construction period, and the interest on the drawn balance is paid from the loan, so it is part of the total installed cost as in the annual model (where IDC is debt × r × ½ × construction years).
- The grace period and the tenor stay in years. The balance is fully repaid in the last period of the tenor.
- The yearly DSCR, LLCR, tax, equity cash flow and returns are those of the annual model, on the yearly sums.

## Loan or tariff in another currency

Set the other currency's code, then choose what is in it: the loan, the tariff components, or both. The rate x_t is the project currency per unit of the other currency: x_0 at COD, then flat, x_0 × (1 + e)^t, or a yearly table whose last value holds.

- **Loan.** It is sized in the project currency at COD and fixed in the other currency at x_0. The schedule runs in the loan's currency (sculpting on CFADS_t / x_t), and each payment is converted at x_t. The realised exchange loss on the principal repaid, principal × (x_t − x_0), is deductible; the translation of the remaining balance is not taxed. DSCR is on the converted debt service; LLCR is in the loan's currency.
- **Tariff.** The components are converted at x_t each year (tariff_t = components_t × scale × x_t). The diesel-discount tariff and the host-owned revenue stay in the project currency.
- **Sensitivity.** The results add the returns with the rate of every operating year multiplied by 0.8, 0.9, 1.0, 1.1, 1.2 and 1.3 (the project currency 20 % stronger to 30 % weaker), the tariff scale kept: equity and project IRR, equity NPV, the lowest DSCR (per period when the loan is paid in periods) and, for the flip, the partners' IRRs.
- Operating costs stay in the project currency. One other currency is modelled.

## Partnership flip

The project company is a partnership: it pays no income tax and no withholding, and its taxable income (EBITDA − depreciation − interest − exchange loss), tax credits and distributed cash go to two partners.

```
distributed_t = CFADS_t − DS_t − ΔDSRA_t (+ terminal value)            CFADS without entity tax
credits_t     = ITC% × (hard + contingency) in year 1  +  PTC × E_t × (1 + inflation)^(t−1) for t ≤ PTC years
investor_t    = c_t × distributed_t + x_t × (credits_t − tax rate × taxable_t)
sponsor_t     = (1 − c_t) × distributed_t + (1 − x_t) × (credits_t − tax rate × taxable_t)
c_t, x_t      = cash and tax shares before the flip, then after it
equity_t      = investor_t + sponsor_t                                 at t = 0, the investor pays its share of the equity
```

- The flip comes in the first year, not before the flip year, in which the investor's after-tax IRR from COD reaches its target; the shares change from the next year. Or it comes after a fixed year.
- The investor uses its tax losses and credits as they arise (it has the tax capacity that is the point of the structure). The sponsor does too, or, unticked, carries its losses and credits forward, without expiry, against its later share of taxable income.
- Half of the investment tax credit (the share is an input) comes off the depreciation base. Tax holiday, Art. 31E and loss carry-forward of the single-owner structures do not apply to the partners.
- Equity IRR is that of both partners together; the sponsor's and the investor's IRR and NPV (the investor's at its target rate) are reported beside it. A tariff solved for an equity target aims at the sponsor's IRR.
- Project IRR is after tax at the full rate with losses and credits used as they arise.
- Capital accounts, deficit restoration and buyout options are not modelled.

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
| Period DSCR | CFADS_p / DS_p of each debt period; the lowest over the tenor (debt periods only). |
| Sponsor / investor IRR | IRR of each partner's after-tax cash flow, and the year of the flip (partnership flip only). |

## Lessons from two industry financial models

Two industry financial models were studied: a captive lease of PV + BESS to an industrial host that keeps its gensets, and a PV + BESS IPP selling to the state utility under a staged tariff.

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
- an interest formula that refers to a text cell, so the equity IRR and NPV show `#VALUE!`;
- a project phase left out of the equity cash flow and of depreciation;
- levered and unlevered tax computed with different rates and credits;
- year 0 discounted one period too many in the NPV;
- a "levelised tariff" that is the undiscounted ΣRev/ΣkWh, and a DSCR on pre-tax EBITDA rather than CFADS;
- no loss carry-forward, and withholding refunds that produce positive tax in later years;
- straight-line depreciation on total capex, including land and VAT;
- contingency counted three times;
- a consolidation sheet that uses its own stale inputs, and hard-coded year-1 values.

## Presets

Presets are starting points. Check every value against the term sheet.

| Preset | Main values |
|---|---|
| Generic | 25 % tax, 70 % gearing at 8 % / 12 yr, DSCR 1.30 sculpted, 6-month DSRA, 0.5 % insurance |
| Indonesia PLN IPP (PV + BESS) | PPA 20 yr; A 0.085/0.035, B 0.025, E = 30 %·(A+B), F = 60 %·(A+B), stage 2 from year 11; 22 % CIT, 2 % WHT, Art. 31E (IDR 4.8 bn / 50 bn); group-4 DB depreciation, battery 8 yr; 70 % at 7.4 %, 10 yr, DSCR 1.20; 2 % fee; 11 % VAT capitalised; 0.9 % insurance; 60 receivable days; transfer at end |
| Captive lease to industrial host | Third-party; 0.15/kWh + 1.5 %/yr; 90 % ToP; 11 % VAT on tariff; 22 % CIT, 2 % WHT, 31E; 70 % at 10 %, 10 yr equal principal; 0.3 % insurance; transfer at end |
| Tariff at a discount to diesel | Third-party; tariff = 75 % of the diesel-only fuel + O&M cost per kWh (follows fuel escalation); 90 % ToP |
| Quarterly loan in US dollars | Quarterly sculpted debt service, 6-month DSRA; the loan in USD at 7.5 %, at 15,500 per USD for a project in IDR (1 otherwise), the project currency weakening 3 %/yr. A project in USD gets only the quarterly terms. |
| Partnership flip with tax credit | Flip; 21 % tax, 30 % ITC (half off the depreciation base), 5-year declining balance; the investor pays 40 % of the equity for 20 % of the cash and 99 % of the tax until a 7 % IRR (not before year 5), then 5 % of both; the sponsor carries its tax forward; 30 % gearing at 6.5 %, 15 yr |

The term-sheet presets (Generic, PLN, captive lease, partnership flip) set a yearly loan in the project currency.
