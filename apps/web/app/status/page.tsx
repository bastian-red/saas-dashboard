import { statusSchema, type Status } from '@saas/shared';
import Link from 'next/link';

import { Brand } from '../../components/brand';
import { apiBaseUrl } from '../../lib/config';

export const metadata = { title: 'Status' };
export const dynamic = 'force-dynamic';

/**
 * Public, like each service's /health: the API, ingest and the aggregator,
 * with every dependency check, fed by the API's GET /status. A page that 500s
 * when a dependency is down cannot tell you the dependency is down, so a
 * failure to reach the API is rendered, not thrown.
 */
async function load(): Promise<Status | null> {
  try {
    const response = await fetch(`${apiBaseUrl}/status`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    });
    const parsed = statusSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const SERVICE_TEXT: Record<string, string> = {
  api: 'Accounts, workspaces, dashboards and billing',
  ingest: 'Accepts events from API keys (POST /v1/events)',
  aggregator: 'Rolls events up into the hourly numbers dashboards read',
};

export default async function StatusPage() {
  const status = await load();
  const allOk = status !== null && status.services.every((s) => s.status === 'ok');

  return (
    <main id="main" className="work" style={{ maxWidth: '52rem', margin: '0 auto' }}>
      <header className="page-head">
        <div className="page-head-text">
          <Brand />
          <h1>Status</h1>
          <p className="status-word" data-state={allOk ? 'ok' : 'danger'} data-testid="overall">
            <span aria-hidden="true">{allOk ? '●' : '▲'}</span>
            {status === null
              ? 'The API is not answering'
              : allOk
                ? 'Every service is up'
                : 'Something is degraded'}
          </p>
        </div>
        <Link href="/">Back to the app</Link>
      </header>

      {status === null ? null : (
        <div className="status-list">
          {status.services.map((service) => (
            <section
              key={service.service}
              className="panel section"
              style={{ marginBottom: 0 }}
              aria-labelledby={`svc-${service.service}`}
              data-service={service.service}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  alignItems: 'baseline',
                }}
              >
                <h2 id={`svc-${service.service}`}>{service.service}</h2>
                <span
                  className="status-word"
                  data-state={service.status === 'ok' ? 'ok' : 'danger'}
                >
                  <span aria-hidden="true">
                    {service.status === 'ok' ? '●' : service.status === 'unreachable' ? '✕' : '▲'}
                  </span>
                  {service.status === 'ok'
                    ? 'Up'
                    : service.status === 'unreachable'
                      ? 'Unreachable'
                      : 'Degraded'}
                </span>
              </div>
              <p className="muted">{SERVICE_TEXT[service.service]}</p>
              {service.status === 'unreachable' ? (
                <p className="muted">No answer ({service.detail}).</p>
              ) : (
                <table className="table">
                  <caption className="visually-hidden">{service.service} dependency checks</caption>
                  <tbody>
                    {service.checks.map((check) => (
                      <tr key={check.name}>
                        <th scope="row" style={{ fontWeight: 400, color: 'var(--text)' }}>
                          <span aria-hidden="true">{check.status === 'ok' ? '✓ ' : '✕ '}</span>
                          {check.name}
                          {check.detail === null ? null : (
                            <span className="muted"> · {check.detail}</span>
                          )}
                        </th>
                        <td className="num">
                          {check.status === 'ok' ? `${String(check.latencyMs)} ms` : 'failing'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {service.status === 'unreachable' ? null : (
                <p className="muted mono">
                  v{service.version} · up {Math.floor(service.uptimeSeconds / 60)} min
                </p>
              )}
            </section>
          ))}
          <p className="muted">Checked {status.checkedAt}</p>
        </div>
      )}
    </main>
  );
}
