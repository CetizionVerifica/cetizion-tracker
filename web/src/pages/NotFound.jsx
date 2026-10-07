import { Link } from 'react-router-dom';
import { Package } from 'lucide-react';
import { PageHeader } from '../App.jsx';
import { useAuth } from '../lib/auth.jsx';

/**
 * An address nothing lives at, and the admin-only pages for everyone else
 * (App.jsx AdminOnly). The way back is the person's own home: Today, or the
 * travel dashboard for the travel desk.
 */
export default function NotFound() {
  const { isHr } = useAuth();
  return (
    <>
      <PageHeader title="Page not found" subtitle="Nothing lives at this address." eyebrow="" />
      <div className="page">
        <section className="mg-glass mg-empty" data-a="rise" style={{ padding: '72px 24px', borderRadius: 26 }}>
          <span className="mg-empty__mark" style={{ width: 64, height: 64 }}>
            <Package size={26} strokeWidth={1.8} aria-hidden="true" />
          </span>
          <h2 className="mg-empty__title" style={{ fontSize: 18 }}>That page does not exist</h2>
          <p className="mg-empty__text">The link may be out of date, or the record it pointed at has been deleted.</p>
          <Link className="mg-btn mg-btn--primary" style={{ marginTop: 8 }} to={isHr ? '/travel-dashboard' : '/'}>
            {isHr ? 'Back to the travel dashboard' : 'Back to Today'}
          </Link>
        </section>
      </div>
    </>
  );
}
