# How the taste guidelines were derived

The default `src/guidelines.ts` were not hand-written from scratch — they were derived
from **151 historical "meal change" confirmation emails** (Dietly sends one every time you
swap a meal). Each email records:

```
Posiłek:      Śniadanie
Zmieniono z:  <dish you switched AWAY from>
Zmieniono na: <dish you switched TOWARD>
```

So the corpus is a labelled set of *revealed preferences*. For each keyword group we count
how often it shows up in the **from** set (things you moved away from) vs the **to** set
(things you moved toward). `net = to − from`:

(Numbers below are the output of `node scripts/analyze-mbox.ts`, so they're reproducible.)

| group                         | from (avoid) | to (chose) | net  | reading |
|-------------------------------|:-----------:|:----------:|:----:|---------|
| sweet porridge breakfast      | 37 | 5  | **−32** | strongest signal — you avoid oat/millet/semolina porridge |
| goulash / heavy stew          | 16 | 3  | **−13** | avoid |
| vege/vegan cheese             | 8  | 0  | **−8**  | avoid (→ "vege white cheese") |
| pork                          | 18 | 8  | −10 | mixed: avoids pork stews, *likes* bacon & pulled pork → kept neutral |
| vege/soy meat                 | 1  | 0  | −1  | rarely in this sample, but user-stated → hard skip |
| egg-based                     | 1  | 16 | **+15** | strongest positive — you seek egg dishes |
| fish                          | 1  | 14 | **+13** | prefer |
| chicken                       | 24 | 33 | **+9**  | prefer |
| pasta                         | 2  | 8  | +6  | prefer |
| beef                          | 3  | 4  | +1  | mild |
| shake / smoothie              | 11 | 9  | −2  | slight avoid (also hard-capped at 1/day by user rule) |

### Resulting rules
- **Hard skip:** vege/vegan cheese, vege/soy meat (also user-stated).
- **Strong avoid:** sweet-porridge breakfasts, goulash/stews.
- **Prefer (ranking):** eggs (≫) > chicken > fish / pasta / beef.
- **Constraint:** max 1 shake/smoothie per day (user-stated).
- **Pork** left deliberately neutral because the data genuinely splits.

### Reproduce it
```bash
node scripts/analyze-mbox.ts path/to/your.mbox
```
(The raw mbox is personal data and is **not** committed — see `.gitignore`.)

### Caveats
- High confidence: hard-skips, porridge avoidance, egg preference, shake cap (large, consistent counts).
- Low sample (single digits): fish / beef / pasta — used only as tie-breakers.
- Matching is on Polish dish names + ingredient lists; it's heuristic, hence the dry-run-first workflow.
