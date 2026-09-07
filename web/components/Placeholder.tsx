import Link from 'next/link';

/**
 * A route for work that does not exist yet.
 *
 * It says what the page will do, which issue delivers it, and what is actually
 * blocking it. It shows no numbers, no example records and no sample flow,
 * because a screenshot of invented data is indistinguishable from a screenshot
 * of real data, and one faked panel puts every honest one on this site in
 * doubt.
 */
export function Placeholder({
  badge,
  title,
  body,
  spec,
}: {
  badge: string;
  title: string;
  body: React.ReactNode;
  spec: { key: string; value: React.ReactNode }[];
}) {
  return (
    <div className="wrap placeholder">
      <span className="placeholder-badge">{badge}</span>
      <h1 className="placeholder-title">{title}</h1>
      <div className="placeholder-body">{body}</div>
      <ul className="spec">
        {spec.map((s) => (
          <li key={s.key}>
            <span className="spec-key">{s.key}</span>
            <span>{s.value}</span>
          </li>
        ))}
      </ul>
      <p className="placeholder-body">
        <Link href="/">← The market page is live, and reads real registrations.</Link>
      </p>
    </div>
  );
}
