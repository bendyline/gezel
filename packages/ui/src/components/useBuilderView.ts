import { useInterests } from './useInterests.js';
import { useShowAdvancedFeatures } from './useShowAdvancedFeatures.js';

/**
 * Whether the person builds with Gezel's machinery: they said they write
 * software, or turned advanced features on. One test decides every default
 * that splits the owner's view from the builder's: whether the rail's folded
 * group starts open, whether the title bar shows worker and quota readouts
 * at rest, and whether a project's status bar shows its routine state.
 *
 * It only sets what is shown by default. Nothing it folds away is out of
 * reach, and a state the person has to act on is shown in either view.
 */
export function useBuilderView(): boolean {
  const showAdvancedFeatures = useShowAdvancedFeatures();
  const { areas } = useInterests();
  return showAdvancedFeatures || areas.includes('software');
}
