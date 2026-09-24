import { PageHeader } from '../App.jsx';
import { Card, Empty, ErrorState, Stat } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useFetch } from '../lib/hooks.js';

/**
 * What is missing, and where to fix it (#74).
 *
 * The tracker flags a missing value on the record's own page and nowhere
 * else, so people found out when a report looked wrong. Each card is one
 * check; its link opens the list filtered to exactly the records it counts.
 */
export default function DataQuality() {
  const { data, loading, error, refetch } = useFetch(() => api.raw('/dashboard/data-quality'));
  const checks = data?.data.checks || [];
  const missing = checks.filter((check) => check.count > 0);

  return (
    <>
      <PageHeader
        title="Data quality"
        subtitle="What is missing, and where to fix it"
        actions={<button type="button" className="btn" onClick={refetch}>Refresh</button>}
      />

      <div className="page stack">
        {error && <ErrorState message={error} onRetry={refetch} />}

        {!error && !loading && !missing.length && (
          <Card>
            <Empty icon="✓" title="Nothing missing" text="Every check below is at zero." />
          </Card>
        )}

        {!error && (
          <div className="auto-grid--stats">
            {checks.map((check) => (
              <Stat
                key={check.key}
                label={check.label}
                value={check.count}
                tone={check.count > 0 ? 'warning' : 'success'}
                meta={check.count > 0 ? 'Open the list to fix →' : 'All complete'}
                to={check.link}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
