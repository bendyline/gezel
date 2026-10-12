import type { Poppetje as PoppetjeStruct } from '@bendyline/gezel';
import { GezelIcon } from '../../components/GezelIcon.js';
import { Poppetje } from '../../poppetje/index.js';

/**
 * The meester standing full-figure on their plank, with a name label. The
 * greeting band and the welcome both stage the meester this way, so it is
 * the same figure wherever the person meets them.
 */
export function MeesterFigure({
  meesterName,
  meesterPoppetje,
  meesterIcon,
  meesterIconOverride,
  size = 64,
  className,
}: {
  meesterName: string;
  meesterPoppetje: PoppetjeStruct | null;
  meesterIcon: string | null;
  meesterIconOverride: boolean;
  size?: number;
  className?: string;
}) {
  return (
    <div className={className ? `home-workshop-figure ${className}` : 'home-workshop-figure'}>
      {meesterPoppetje ? (
        <Poppetje
          poppetje={meesterPoppetje}
          variant="full"
          size={size}
          title={`${meesterName} poppetje`}
        />
      ) : (
        <GezelIcon
          poppetje={null}
          svg={meesterIcon}
          iconOverride={meesterIconOverride}
          name={meesterName}
          size={size}
          variant="full"
        />
      )}
      <div className="home-workshop-shelf" />
      <div className="home-workshop-figure-label">
        {meesterName} <em>- Meester</em>
      </div>
    </div>
  );
}
