import type { Site } from '../types.ts';

export default function SitePicker({ sites, siteId, select }: {
  sites: Site[]; siteId: string; select: (id: string) => void;
}) {
  if (sites.length < 2 && siteId) return null;
  const groups = [
    { name: 'Researched agricultural zones', sites: sites.filter(({ properties }) => properties.field_zone) },
    { name: 'Mapped survey', sites: sites.filter(({ properties }) => properties.survey_available) },
    { name: 'Planning pilot', sites: sites.filter(({ properties }) => !properties.field_zone && !properties.survey_available) },
  ];
  return <select className="site-select" aria-label="Agricultural site" value={siteId} onChange={event => select(event.target.value)}>
    {!siteId && <option value="" disabled>Select a site…</option>}
    {groups.filter(group => group.sites.length > 0).map(group => <optgroup key={group.name} label={group.name}>
      {group.sites.map(({ properties }) => <option key={properties.site_id} value={properties.site_id}>{properties.label}</option>)}
    </optgroup>)}
  </select>;
}
