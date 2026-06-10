# 🥗 dietly-autopilot

Automatically pick your [Dietly](https://dietly.pl) **Wybór Menu** catering meals according
to your taste — so you don't have to open the app and re-pick every dish, every day.

It logs into your Dietly account, looks at the upcoming (still-editable) delivery days, and
for each meal slot swaps the chosen dish to the best option that matches **your guidelines**
(e.g. *never pick vege/soy "meat" or vegan cheese, avoid sweet-porridge breakfasts, prefer
egg dishes and chicken, max one shake per day*).

> **Unofficial.** This uses Dietly's private internal JSON API (reverse-engineered, see
> [`docs/dietly-api.md`](docs/dietly-api.md)). No affiliation with Dietly / MasterLife
> Solutions. For personal use. The API may change at any time.

## How the defaults were chosen

The bundled guidelines aren't arbitrary — they were mined from **151 of my own historical
"meal change" emails**, treating every past swap as a revealed preference. See
[`docs/preference-analysis.md`](docs/preference-analysis.md) for the numbers. Replace
`src/guidelines.ts` with your own.

## Install

Requires **Node ≥ 22** (uses native TypeScript execution + `fetch`; zero runtime deps).

```bash
git clone https://github.com/jtomaszewski/dietly-autopilot.git
cd dietly-autopilot
npm install            # dev-only deps (typescript, @types/node)
cp .env.example .env   # then fill in your Dietly email + password
```

## Usage

```bash
# Preview — reads your upcoming menu, prints proposed swaps, writes NOTHING:
npm run dry-run                 # or: node src/cli.ts dry-run --days 14

# Actually apply the swaps:
npm run apply                   # or: node src/cli.ts apply --days 14
```

Example output:

```
=== Order #152698 (Wybór menu, 3000 kcal) ===

  2026-06-15  —  1 change(s)
    ✓  Śniadanie: Sałatka ze słodko-ostrym kurczakiem i dressingiem z awokado
    ✓  II Śniadanie: Parfait z musem truskawkowym i bezglutenową granolą
    ✏️  Obiad: Potrawka z kotletami sojowymi z białym ryżem
        → Spaghetti bolognese z indykiem i bazylią   [current is vege/soy meat; +1 pasta; score -? → 1]
    ✓  Podwieczorek: Koktajl z kiwi i imbirem
    ✓  Kolacja: Kurczak tandori z surówką śródziemnomorską
```

`dry-run` is always safe. `apply` is the only command that writes.

## Configuration

`.env` (see `.env.example`):

| var | default | meaning |
|-----|---------|---------|
| `DIETLY_EMAIL` / `DIETLY_PASSWORD` | — | your Dietly login (no MFA supported) |
| `DIETLY_COMPANY_ID` | `wybormenu` | catering slug (Dietly `company-id` header) |
| `DIETLY_HORIZON_DAYS` | `14` | how many days ahead to consider |

Your guidelines live in [`src/guidelines.ts`](src/guidelines.ts) — hard skips, soft
preferences (weighted), and the per-day shake cap. Plain lowercase substring matching on
Polish dish names (and ingredients, for skips).

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
4. Score options against your guidelines, enforce the shake cap, pick the best allowed dish.
5. `dry-run` reports; `apply` commits via `PUT …/switch?dietCaloriesMealId=…`.

See [`docs/dietly-api.md`](docs/dietly-api.md) for the full reverse-engineered API contract.

## Safety & privacy

- Credentials stay in `.env` (gitignored). Nothing is sent anywhere except Dietly.
- Your mail export / personal data is gitignored and never committed.
- `dry-run` first. The matcher is heuristic — review proposals before trusting `apply`.

## License

[MIT](LICENSE) © 2026 Jacek Tomaszewski
