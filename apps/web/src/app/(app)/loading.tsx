import { SkeletonRows } from '@cleanpost/ui';

/** G-20 Loading: skeletons, never a full-page spinner. */
export default function Loading() {
  return <SkeletonRows rows={6} label="Loading page" />;
}
