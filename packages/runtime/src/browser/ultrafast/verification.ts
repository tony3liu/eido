// Independent verifier from upstream examples/flights.py. MIT, Browser Use 2026.
import type {Snapshot} from './types.ts';
export const FLIGHTS_URL='https://www.google.com/travel/flights?hl=en';
export const FLIGHTS_GOAL='Find one-way flights from Zurich to London on September 20, 2026, for one adult in economy. Stop when matching flight options are visible. Do not select or book a flight.';
export function verifyFlights(page:Pick<Snapshot,'url'|'text'> & {actions:{label:string;value?:string}[]}) {
  const parsed=new URL(page.url),encoded=parsed.searchParams.get('tfs')??'';
  const dateInUrl=Buffer.from(encoded,'base64url').includes(Buffer.from('2026-09-20'));
  const values=Object.fromEntries(page.actions.map(a=>[a.label.trim(),a.value]));
  const flights=page.actions.filter(a=>a.label.includes('Select flight')).map(a=>a.label);
  const checks={search_page:parsed.hostname==='www.google.com'&&parsed.pathname==='/travel/flights/search',
    one_way:values['Change ticket type. One way']==='One way',origin:values['Where from?']==='Zürich',
    destination:values['Where to?']==='London',date:values.Departure==='Sun, Sep 20',
    year:dateInUrl||page.text.includes('departing 2026-09-20'),results:flights.length>0&&flights.every(f=>f.includes('Sunday, September 20'))};
  return {passed:Object.values(checks).every(Boolean),checks,visible_flights:flights};
}
export function verifyTravel(page:Pick<Snapshot,'url'|'text'>) {
  const checks={property:page.url.endsWith('#casa-flora'),filters:page.text.includes('Your filters: Design · Free cancellation enabled · Destination Lisbon')};
  return {passed:Object.values(checks).every(Boolean),checks};
}
