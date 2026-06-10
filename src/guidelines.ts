/**
 * Taste guidelines, derived from 151 historical meal-change confirmation emails
 * (see docs/preference-analysis.md for the numbers). Edit freely — this is the
 * single source of truth the picker optimizes against.
 *
 * Matching is plain lowercase substring matching on Polish dish names (and, for
 * `hardSkip`/`shake`, also the ingredient list). Keep patterns specific enough to
 * avoid false positives (e.g. match "kotlet sojowy", NOT bare "sojow", so that a
 * chicken dish "w sosie sojowym" / soy sauce isn't mistaken for vege-meat).
 */

export interface MatchRule {
  label: string;
  /** lowercase substrings; rule matches if ANY is found */
  any: string[];
}

export interface WeightedRule extends MatchRule {
  weight: number;
}

export interface Guidelines {
  /** Never select; if currently chosen, swap away to the best allowed option. Matches name + ingredients. */
  hardSkip: MatchRule[];
  /** Strongly deprioritize (subtracted from score). Matches dish name. */
  strongAvoid: WeightedRule[];
  /** Preferred dish types (added to score), used as ranking + tie-breakers. Matches dish name. */
  prefer: WeightedRule[];
  /** Per-day cap on shakes/smoothies. Matches name + ingredients. */
  shake: { max: number; any: string[] };
  /**
   * Minimum score gain over the current dish required to swap an *otherwise fine* meal.
   * Keeps the bot from churning the menu for trivial (+1) gains. Hard-skips and
   * strong-avoids always trigger a change regardless of this threshold.
   */
  minImprovement: number;
}

export const guidelines: Guidelines = {
  hardSkip: [
    {
      label: 'vege/vegan cheese',
      any: [
        'wegańska feta',
        'wegańską fetą',
        'wegańskiej fety',
        'wegański ser',
        'wegańskim serem',
        'wegański twaróg',
        'wegańska mozzarella',
        'serek z orzechów nerkowca',
        'serek z nerkowca',
        'pasta z nerkowca',
        'serek z orzechów',
      ],
    },
    {
      label: 'vege/soy meat',
      any: [
        'kotlet sojowy',
        'kotlety sojowe',
        'kotletami sojowymi',
        'pulpety sojowe',
        'gulasz sojowy',
        'strogonow sojowy',
        'kostka sojowa',
        'tofu',
        'seitan',
      ],
    },
  ],

  strongAvoid: [
    {
      label: 'sweet porridge / milk-grain breakfast',
      weight: 5,
      any: ['owsiank', 'jaglank', 'jaglany', 'jaglana', 'kasza manna', 'manna', 'budyń', 'ryżank'],
    },
    {
      label: 'goulash / heavy stew',
      weight: 4,
      any: ['gulasz', 'potrawka'],
    },
  ],

  prefer: [
    {
      label: 'egg-based',
      weight: 3,
      any: ['omlet', 'frittat', 'jajeczn', 'jajecznica', 'zapiekanka jajeczna', 'muffiny jajeczne'],
    },
    { label: 'chicken', weight: 2, any: ['kurczak'] },
    { label: 'fish', weight: 1, any: ['łoso', 'makrel', 'dorsz', 'tuńczyk', 'śledź', 'pstrąg', 'ryby', 'rybna', 'rybny'] },
    { label: 'pasta', weight: 1, any: ['makaron', 'spaghetti', 'penne', 'tagliatelle'] },
    { label: 'beef', weight: 1, any: ['wołow'] },
  ],

  shake: { max: 1, any: ['koktajl', 'smoothie', 'shake'] },

  minImprovement: 2,
};
