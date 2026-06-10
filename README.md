# 🥗 dietly-autopilot

Automatically pick your [Dietly](https://dietly.pl) **Wybór Menu** catering meals according
to your taste — so you don't have to open the app and re-pick every dish, every day.

It logs into your Dietly account, looks at the upcoming (still-editable) delivery days, and for
each day hands your meals + the available alternatives to an **LLM** (via
[OpenRouter](https://openrouter.ai), default `google/gemini-2.5-flash`) along with **your
guidelines in plain markdown**. The model decides, per slot, whether to keep the dish or switch
it — e.g. *never pick vege/soy "meat" or vegan cheese, avoid sweet-porridge breakfasts, prefer
egg dishes and chicken, max one shake per day*.

The decision is the model's; the code only fetches the menu, hands it over, and applies thin
guardrails (it can only choose an option that was actually offered, and never edits a locked day).

> **Unofficial.** This uses Dietly's private internal JSON API (reverse-engineered, see
> [`docs/dietly-api.md`](docs/dietly-api.md)). No affiliation with Dietly / MasterLife
> Solutions. For personal use. The API may change at any time.

## Your guidelines

Preferences live in [`GUIDELINES.md`](GUIDELINES.md) — plain English, edit freely; the whole
file is handed to the model. The bundled defaults aren't arbitrary: they were mined from **151
of my own historical "meal change" emails**, treating every past swap as a revealed preference
(see [`docs/preference-analysis.md`](docs/preference-analysis.md) for the numbers).

## Install

Requires **Node ≥ 22** (uses native TypeScript execution + `fetch`; zero runtime deps).

```bash
git clone https://github.com/jtomaszewski/dietly-autopilot.git
cd dietly-autopilot
npm install            # dev-only deps (typescript, @types/node)
cp .env.example .env   # Dietly email + password, and an OpenRouter API key
```

## Usage

```bash
# Preview — reads your upcoming menu, prints proposed swaps, writes NOTHING:
npm run dry-run                 # or: node src/cli.ts dry-run --days 14

# Full daily digest — every slot's pick AND all alternatives, so you can skim and
# decide whether to tweak GUIDELINES.md or pick something else yourself:
node src/cli.ts dry-run --days 14 --options

# Actually apply the swaps:
npm run apply                   # or: node src/cli.ts apply --days 14
```

With `--options` each slot lists its alternatives, marked `← kept` / `← new pick` /
`← current (replaced)`, plus the model's one-line reason per slot:

```
  2026-06-16  —  1 change(s)
    ✏️  Śniadanie: Sałatka z brzoskwinią, kurczakiem i wegańską fetą
        → Pasta kanapkowa z awokado i jajka …   [current has vegan feta (never-pick); switched to an egg dish]
         · [OPTIMAL] Pulled pork w sosie BBQ … (707 kcal)
         ✓ [NISKI IG] Pasta kanapkowa z awokado i jajka … (736 kcal)  ← new pick
         ✗ [SPORT] Sałatka z brzoskwinią, kurczakiem i wegańską fetą (717 kcal)  ← current (replaced)
         · [SLIM] Placuszki z białego sera … (784 kcal)
```

Example output:

```
=== Order #152698 (Wybór menu, 3000 kcal) ===

  2026-06-15  —  1 change(s)
    ✓  Śniadanie: Sałatka ze słodko-ostrym kurczakiem i dressingiem z awokado
    ✓  II Śniadanie: Parfait z musem truskawkowym i bezglutenową granolą
    ✏️  Obiad: Potrawka z kotletami sojowymi z białym ryżem
        → Spaghetti bolognese z indykiem i bazylią   [current is soy "meat"; swapped per guidelines]
    ✓  Podwieczorek: Koktajl z kiwi i imbirem
    ✓  Kolacja: Kurczak tandori z surówką śródziemnomorską
```

`dry-run` is always safe. `apply` is the only command that writes.

## Configuration

`.env` (see `.env.example`):

| var | default | meaning |
|-----|---------|---------|
| `DIETLY_EMAIL` / `DIETLY_PASSWORD` | — | your Dietly login (no MFA supported) |
| `OPENROUTER_API_KEY` | — | OpenRouter key — the model makes the decisions |
| `OPENROUTER_MODEL` | `google/gemini-2.5-flash` | any OpenRouter model with structured-output support |
| `DIETLY_COMPANY_ID` | `wybormenu` | catering slug (Dietly `company-id` header) |
| `DIETLY_HORIZON_DAYS` | `14` | how many days ahead to consider |
| `DIETLY_GUIDELINES_PATH` | `GUIDELINES.md` | path to your guidelines markdown |

Your guidelines live in [`GUIDELINES.md`](GUIDELINES.md) — plain English. One LLM call is made
per editable day (all five slots together, so the per-day shake cap is reasoned about holistically),
at `temperature 0` with a strict JSON schema.

## Running on a schedule

Editing closes ~1.5 days before each delivery, so run every couple of days to catch newly
opened days. Any scheduler works, e.g. cron:

```cron
# 08:00 every other day
0 8 */2 * * cd /path/to/dietly-autopilot && /usr/bin/node src/cli.ts apply >> autopilot.log 2>&1
```

## How it works

1. `POST /api/auth/login` → cookie session.
2. List active orders → each order's upcoming deliveries (date + id).
3. Per day: read the 5 chosen meals; per slot, list switch options (`…/switch`).
4. Hand the day (current dishes + options) + your `GUIDELINES.md` to the model; it returns a
   keep/change decision per slot. Guardrails reject any option that wasn't offered.
5. `dry-run` reports; `apply` commits via `PUT …/switch?dietCaloriesMealId=…`.

See [`docs/dietly-api.md`](docs/dietly-api.md) for the full reverse-engineered API contract.

## Safety & privacy

- Credentials stay in `.env` (gitignored). Nothing leaves your machine except calls to Dietly
  and to OpenRouter (which receives the day's menu + your guidelines, not your credentials).
- Your mail export / personal data is gitignored and never committed.
- `dry-run` first. The model's picks are guardrailed but not infallible — review before `apply`.
- On any LLM/network error the day fails safe: meals are left unchanged.

## License

[MIT](LICENSE) © 2026 Jacek Tomaszewski
