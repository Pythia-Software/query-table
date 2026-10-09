/* Design-only bridge to PR #92's dependency-free editor helpers. */
import { formulaCompletions, signatureAt } from '../../packages/ui/src/formulaEditorHelpers';
import { FORMULA_FUNCTIONS } from '../../packages/core/src/formula';
Object.assign(window, { metricExpressionTools: { formulaCompletions, signatureAt, functions: FORMULA_FUNCTIONS } });
