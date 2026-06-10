# Dietly internal API — recon notes (2026-06-10)

Reverse-engineered from `panel.dietly.pl` / `dietly.pl` SPA. No public API; this is the
private JSON API the web app uses. Auth = cookie session (httpOnly). All calls need headers:

```
accept: application/json
company-id: <catering slug, e.g. wybormenu>
x-launcher-type: BROWSER_DIETLY
```

After login the app runs on `https://dietly.pl/api/...` (panel.dietly.pl redirects there).

## Auth
- `POST https://panel.dietly.pl/api/auth/login`
  - body: `application/x-www-form-urlencoded` → `username=<email>&password=<pwd>`
  - 200, empty body, sets httpOnly session cookie. Reuse cookie jar for all later calls.
- No MFA. Verify with `GET /api/profile` → 200.

## Read
- `GET /api/profile/profile-order/all?page=0` → all orders (paginated, `totalPages`).
  - active order fields: `orderId`, `status:"ACTIVE"`, `dateFrom`, `dateTo`, `companyName`,
    `dietCalories`, `dietName`.
- `GET /api/profile/profile-order/active-ids` → active order ids.
- `GET /api/company/customer/order/{orderId}` → order detail incl. `deliveries[]`:
  - each: `deliveryId`, `date` (YYYY-MM-DD), `deliveryMeals[]` (`deliveryMealId`, `dietCaloriesMealId`).
  - `nearestDelivery.deliveryDates[]` = all delivery dates.
- `GET /api/company/general/menus/delivery/{deliveryId}/new` → chosen meals for that day:
  - `deliveryMenuMeal[]`: one per slot. Key fields: `mealName` (Śniadanie/II Śniadanie/Obiad/
    Podwieczorek/Kolacja), `menuMealName` (dish), `deliveryMealId`, `dietCaloriesMealId`,
    `switchable`, `allergens[]`, `allergensWithExcluded[]`, `ingredients[]` (each ingredient has
    `name` + `exclusion[]` with `dietaryExclusionId`,`name`,`chosen`).

## Swap (the core write)
- List alternatives for a slot:
  `GET /api/company/customer/order/{orderId}/deliveries/{deliveryId}/delivery-meals/{deliveryMealId}/switch`
  → `mealChangeOptions[]`, each:
    - `dietOptionName` (SPORT/OPTIMAL/SLIM/NISKI IG/WEGE = variant line)
    - `menuMealDetails`: `menuMealName`, `dietCaloriesMealId` (← the target id), `allergens[]`,
      `allergensWithExcluded[]`, `ingredients[]` (with exclusion metadata), `nutrition`, `mealName`.
    - `canBeChanged`, `mealRecommended`, `reviewSummary`.
- Commit a swap:
  `PUT .../deliveries/{deliveryId}/delivery-meals/{deliveryMealId}/switch?amount=1&dietCaloriesMealId={targetId}`
  → 200, returns updated meal `{deliveryMealId, amount, dietCaloriesMealId, seen:"SWITCHED", ...}`.
  - `deliveryMealId` (the slot) stays CONSTANT across switches — only `dietCaloriesMealId` changes.
  - Verified end-to-end: switched 06-15 breakfast 2345→2354, then reverted 2354→2345. No side effects.

## Editing window / cutoff
- Calendar marks each day: `Edytuj` (editable), `Zobacz` (view-only, past cutoff), `Oceń` (delivered).
- Cutoff ≈ ~1.5 days before delivery ("Masz jeszcze X dni Y godzin na zmianę posiłków").
- So the bot can only edit days roughly ≥2 days out. Today 06-15 had "1 dzień 16h" left and was still editable.

## Dietly-native exclusions (relevant to rules)
- `GET /api/profile/dietary-exclusions` — Dietly already supports excluding allergens/ingredients.
- Each meal option carries `allergensWithExcluded[]` and per-ingredient `exclusion[]` (dietaryExclusionId).
- BUT "skip vege meat / vege white cheese" are NOT standard allergens — they're dish/ingredient
  matches (e.g. "kotlety sojowe" = soy cutlets = vege meat). Rules engine must match on
  `menuMealName` + `ingredients[].name`. Variant `dietOptionName=WEGE` flags vegetarian options.

## Example (current active order)
- orderId 152698, catering `wybormenu` (Wybór Menu), STANDARD 25 / 3000 kcal, 5 meals/day,
  2026-06-03 → 08-03, 40 deliveries. Address Poznań, delivery do 08:00.
- Slots use `dietCaloriesMealId` per variant; e.g. breakfast options:
  2345 SPORT (kurczak salad) / 2354 OPTIMAL (jajeczna pasta) / 2339 NISKI IG / 2359 WEGE / 2351 SLIM.
