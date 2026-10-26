import React from 'react';
import { OBSERVATION_META, ObservationKind } from '../types/observatory';

interface ObservationBadgeProps {
  kind: ObservationKind;
  size?: 'sm' | 'md';
}

export const ObservationBadge: React.FC<ObservationBadgeProps> = ({ kind, size = 'sm' }) => {
  const meta = OBSERVATION_META[kind] ?? OBSERVATION_META.unavailable;
  const sizeClasses = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs';

  return (
    <span
      title={meta.description}
      data-testid={`observation-badge-${kind}`}
      className={`inline-flex items-center gap-1.5 rounded-full border font-medium tracking-tight ${sizeClasses} ${meta.badgeClass}`}
    >
      <span aria-hidden="true" className="font-mono">
        {meta.symbol}
      </span>
      <span>{meta.label}</span>
    </span>
  );
};
