// Pure calculation helpers. No DOM, no state, no side effects.

// Canada's standard drink definition: 17.05 ml of pure ethanol (13.45 g).
// Source: https://www.canada.ca/en/health-canada/services/substance-use/alcohol/low-risk-alcohol-drinking-guidelines.html
export const STD_DRINK_ML = 17.05;

// Imperial fluid ounce (Canada/UK), not US. Matches Measurement Canada's
// definition where a draft pint = 20 imp fl oz = 568 ml exactly.
// https://ised-isde.canada.ca/site/measurement-canada/en/buying-and-selling-measured-goods/units-measurement-used-sell-draft-beer
export const ML_PER_OZ = 28.4131;

// Pure ethanol (in ml) contained in a single drink of { volumeMl, abv }.
export const ethanolOf = (d) => (d.volumeMl * d.abv) / 100;

// Aggregate per-person stats.
export function personStats(person) {
  const ethanolMl = person.drinks.reduce((s, d) => s + ethanolOf(d), 0);
  return {
    count: person.drinks.length,
    ethanolMl,
    standardDrinks: ethanolMl / STD_DRINK_ML,
  };
}
