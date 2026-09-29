import { describe, expect, it } from 'vitest';
import { checkFigures, extractMoneyAmounts } from './figures.js';

const TODAY = '2026-09-28';

// The review run's catering quote, as the crew wrote it.
const QUOTE = `# Catering Quote

**To:** Maya Chen
**Date:** September 29, 2026
**Event Date:** Friday, October 10 at 8am

---

## Option 1: Signature Pastries Mix

| Item | Quantity | Price per Unit | Subtotal |
|------|----------|----------------|----------|
| Croissants (Assorted) | 20 | $3.50 | $70.00 |
| Muffins (Assorted) | 16 | $3.00 | $48.00 |
| Mini Quiches (Cheese & Herb) | 4 | $4.00 | $16.00 |
| **Gluten-Free Muffins** | 4 | $4.00 | $16.00 |
| **Delivery Fee** | 1 | $25.00 | $25.00 |
| **Subtotal** | | | **$175.00** |

---

## Option 2: Fresh Fruit & Coffee Service

| Item | Quantity | Price per Unit | Subtotal |
|------|----------|----------------|----------|
| Seasonal Fruit Platter (Mixed) | 1 | $85.00 | $85.00 |
| Freshly Brewed Coffee Service (12 cups) | 1 | $45.00 | $45.00 |
| Assorted Pastries (Croissants, Muffins) | 12 | $3.50 | $42.00 |
| **Delivery Fee** | 1 | $25.00 | $25.00 |
| **Subtotal** | | | **$297.00** |

---

## Total: $175.00 (Option 1) or $297.00 (Option 2)

Please confirm by **October 3, 2026** to secure this order. Reply with:

- **Confirm Option 1 as quoted ($175)**
- **Confirm Option 2 as quoted ($297)**
`;

const OWNER_SAID =
  'Budget about $300. Our catering prices: croissants $3.50, muffins $3.00, scones $3.25, ' +
  'mini quiches and gluten-free muffins $4.00, delivery $25.';

describe('checkFigures', () => {
  it('catches the review quote: a wrong subtotal, a wrong weekday, and invented prices', () => {
    const result = checkFigures(QUOTE, {
      today: TODAY,
      knownAmounts: extractMoneyAmounts(OWNER_SAID),
    });
    expect(result.findings.map((f) => f.message)).toEqual([
      'October 10, 2026 is a Saturday, not a Friday.',
      "Seasonal Fruit Platter (Mixed) at $85.00: this price didn't come from you.",
      "Freshly Brewed Coffee Service (12 cups) at $45.00: this price didn't come from you.",
      'Under "Option 2: Fresh Fruit & Coffee Service", the subtotal says $297.00, but the items above it add up to $197.00.',
    ]);
    expect(result.checked.sums).toBe(2);
    expect(result.checked.lineMath).toBe(9);
  });

  it('checks prices only against what the owner said', () => {
    const result = checkFigures(QUOTE, { today: TODAY });
    expect(result.findings.some((f) => f.kind === 'unsourced-price')).toBe(false);
    expect(result.checked.prices).toBe(0);
  });

  it('checks list totals, line math, discounts, and a subtotal carried into tax', () => {
    const text = [
      '- Croissants: 20 × $3.50 = $75.00',
      '- Coffee: $45',
      '',
      '**Total: $120**',
      '',
      '## Order',
      '- Cake: $60',
      '- Pie: $40',
      'Subtotal: $100',
      'Tax (8%): $8',
      'Total: $108',
      '',
      '## Party',
      '- Cake: $50',
      '- Discount: $5',
      'Total: $45',
    ].join('\n');
    expect(checkFigures(text, { today: TODAY }).findings.map((f) => f.message)).toEqual([
      'Croissants: 20 × $3.50 is $70.00, not $75.00.',
    ]);
  });

  it('skips what it cannot know instead of guessing', () => {
    const text = [
      '- Croissants $3.50 each',
      '- Coffee: $45',
      'Total: $150',
      '',
      '## Options',
      'Option A',
      '- Tray: $10',
      '- Box: $20',
      'Option B',
      '- Bag: $5',
      'Total: $5',
    ].join('\n');
    expect(checkFigures(text, { today: TODAY }).findings).toEqual([]);
  });

  it('flags dates that have passed, and leaves history alone', () => {
    const text = [
      'Week of May 20, 2024',
      'Please confirm by September 2, 2026.',
      'Baking here since June 1, 2015.',
      'Friday 10 October 2026 works for us.',
      'Delivery on 2026-10-12.',
    ].join('\n');
    expect(checkFigures(text, { today: TODAY }).findings.map((f) => f.message)).toEqual([
      'May 20, 2024 has already passed; check the date.',
      'September 2, 2026 has already passed; check the date.',
      'October 10, 2026 is a Saturday, not a Friday.',
    ]);
  });
});

describe('extractMoneyAmounts', () => {
  it('reads currency amounts in the forms owners type', () => {
    expect(extractMoneyAmounts('about $300, croissants $3.50, **€1,250.5** and £4')).toEqual([
      300, 3.5, 1250.5, 4,
    ]);
  });
});
