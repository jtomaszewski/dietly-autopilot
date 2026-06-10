# My Dietly meal guidelines

Plain-language preferences for the meal picker. Edit freely — this whole file is handed to
the model, which decides per slot whether to keep the current dish or switch it to one of the
offered alternatives. Dishes are Polish (catering: Wybór Menu).

## Never pick (always swap away if currently chosen)
- **Vege / vegan cheese** — vegan feta, vegan twaróg/cottage cheese, cashew or seed "cheese",
  vegan mozzarella. Anything that's an imitation of white cheese.
- **Vege / soy "meat"** — soy cutlets (kotlety sojowe), tofu used as a meat substitute, seitan,
  vegan versions of meat dishes. (Real soy *sauce* in an otherwise normal dish is fine.)

## Avoid (switch to something better when a good option exists)
- **Sweet porridge / milk-grain breakfasts** — oatmeal (owsianka), millet porridge (jaglanka),
  semolina (kasza manna), rice pudding, budyń. I don't enjoy sweet grain breakfasts.
- **Heavy goulash / stews** — gulasz, potrawka.

## Prefer (when choosing a replacement, lean toward these — in rough priority order)
1. **Egg-based dishes** — omelette, frittata, scrambled/egg pastes. My favourite breakfast type.
2. **Chicken.**
3. Fish, pasta, beef — all nice to have.

## Hard constraints
- **At most one shake / smoothie (koktajl / smoothie) per day.** One shake a day is perfectly
  fine — leave it alone. Only act when **two or more** of the day's *currently selected* meals are
  shakes; then keep the single best one and switch the rest to a non-shake option.

## How aggressively to change
- Default to keeping the current dish. Only change when a guideline clearly calls for it — no
  needless churn. A fine savory breakfast (eggs, meat, fish) does not need swapping.
- A "never pick" item must always be swapped away (pick the best allowed alternative even if it's
  not a favourite). "Avoid" and "prefer" only justify a change when the current dish clearly falls
  in an avoid category, or a genuinely better-fitting option exists.
- Egg dishes mean actual eggs (omelette, frittata, egg paste). Cottage cheese (twaróg) is not an
  egg dish.
- Balance the day: don't make every slot the same protein if good variety is available.
