/**
 * Loading skeleton — structure on the first paint instead of an empty screen
 * that pops. Data-free and stateless; the reduced-motion contract lives
 * entirely in Skeleton.module.css, so there is nothing to wire up at a call
 * site beyond the row count.
 */

import styles from "./Skeleton.module.css";

export function Skeleton({ rows }: { rows: number }) {
  return (
    <div className={styles.wrap} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={styles.bar} />
      ))}
    </div>
  );
}
