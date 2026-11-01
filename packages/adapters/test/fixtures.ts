import { syntheticMemberId } from '@cleanpost/testing';
import type { Connection } from '../src';

export const conn = (
  adapterKey: Connection['adapterKey'],
  id = '01a00000-0000-7000-8000-00000000c001',
): Connection => ({
  id,
  tenantId: '01a00000-0000-7000-8000-000000000001',
  clientId: '01a00000-0000-7000-8000-0000000000c1',
  adapterKey,
  credentialsSecretRef: null,
  pmAccountRef: null,
  settings: {},
});

/** Synthetic charge CSV in the docs/15 template: two encounters, three lines. */
export const CHARGE_CSV = [
  'encounter_id,patient_id,patient_last,patient_first,dob,sex,payer_name,member_id,group_number,relationship,dos,rendering_npi,location_id,pos,dx1,dx2,dx3,dx4,line_id,code,mod1,mod2,mod3,mod4,units,charge,dx_pointers',
  `E10021,P5532,Rivera,Ana,1984-03-12,F,Aetna,${syntheticMemberId(5532)},GRP001,self,2026-10-27,1932204417,L1,11,M54.50,,,,1,99213,,,,,1,145.00,1`,
  `E10021,P5532,Rivera,Ana,1984-03-12,F,Aetna,${syntheticMemberId(5532)},GRP001,self,2026-10-27,1932204417,L1,11,M54.50,,,,2,97110,GP,,,,2,"1,210.50",1`,
  `E10022,P5533,Nguyen,Mai,1979-07-01,F,Cigna,${syntheticMemberId(5533)},,self,2026-10-28,1932204417,L1,11,E11.9,I10,,,1,99214,25,,,,1,210.00,1 2`,
].join('\n');
