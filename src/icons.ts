/**
 * @deprecated Import from `'./theme.js'` instead.
 *
 * This module is a thin re-export wrapper. All icon definitions, icon maps,
 * and public API functions live in `src/theme.ts`, which is now the single
 * source of truth for theme content (colours + icons).
 *
 * This wrapper will be removed in a future release.
 *
 * @module
 * @see {@link ./theme.js}
 */

export {
  type IconOptions,
  iconsEnabled,
  priorityIcon,
  priorityLabel,
  priorityFallback,
  statusIcon,
  statusLabel,
  statusFallback,
  riskIcon,
  riskLabel,
  riskFallback,
  effortIcon,
  effortLabel,
  effortFallback,
  stageIcon,
  stageLabel,
  stageFallback,
  auditIcon,
  auditLabel,
  auditFallback,
  auditStaleIcon,
  auditStaleLabel,
  auditStaleFallback,
  needsProducerReviewIcon,
  needsProducerReviewLabel,
  needsProducerReviewFallback,
  epicIcon,
  epicLabel,
  epicFallback,
} from './theme.js';
