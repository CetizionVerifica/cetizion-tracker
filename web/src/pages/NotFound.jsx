import { Link } from 'react-router-dom';
import { PageHeader } from '../App.jsx';
import { Card, Empty } from '../components/ui.jsx';

export default function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <div className="page">
        <Card>
          <Empty
            icon="◇"
            title="That page does not exist"
            text="The link may be out of date, or the record it pointed at has been deleted."
            action={<Link className="btn btn--primary" to="/">Back to the dashboard</Link>}
          />
        </Card>
      </div>
    </>
  );
}
