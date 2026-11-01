import type { ReactNode } from 'react';

export function AuthCard({
  title,
  overline,
  children,
  wide,
}: {
  title: string;
  overline?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <section
      className="card"
      style={
        wide
          ? {
              width: 'min(560px, calc(100vw - 32px))',
              marginInline: 'calc((400px - min(560px, calc(100vw - 32px))) / 2)',
            }
          : undefined
      }
    >
      <div className="card-body stack" style={{ padding: 32 }}>
        <div className="stack-sm">
          {overline && <span className="overline">{overline}</span>}
          <h1 className="display-m" style={{ fontSize: 26 }}>
            {title}
          </h1>
        </div>
        {children}
      </div>
    </section>
  );
}
