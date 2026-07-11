import { describe, expect, it } from 'vite-plus/test';
import { diffUserPoolChildren } from '../src/read/child-enumerators.js';

// #1265: the OpenSearch/Elasticsearch service-client skip (#897) must be GATED on
// corroboration that a domain actually targets THIS user pool. `ClientName` is free-form
// user input, so an out-of-band `create-user-pool-client --client-name
// AmazonOpenSearchService-backdoor` (a token-minting credential, the rogue-IdP threat class
// of #1043) must NOT be silently swallowed when no OpenSearch domain corroborates it. The
// PURE diff is exercised directly with the resolved `openSearchCorroborated` boolean —
// resolving it (same-stack or the live OpenSearch read) is the async enumerator's job.
describe('diffUserPoolChildren OpenSearch corroboration gate (#1265)', () => {
  const POOL = 'us-east-1_AbCdEf123';

  it('surfaces a service-prefixed client as `added` when NOT corroborated (the FN fix)', () => {
    const added = diffUserPoolChildren({
      userPoolId: POOL,
      declaredClientIds: [],
      openSearchCorroborated: false,
      liveClients: [
        {
          id: 'client-backdoor',
          name: 'AmazonOpenSearchService-backdoor',
          label: 'AmazonOpenSearchService-backdoor',
        },
      ],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::Cognito::UserPoolClient',
        identifier: `${POOL}|client-backdoor`,
        label: 'AmazonOpenSearchService-backdoor',
        live: { ClientId: 'client-backdoor' },
      },
    ]);
  });

  it('skips a service-prefixed client when corroborated (preserves #897)', () => {
    const added = diffUserPoolChildren({
      userPoolId: POOL,
      declaredClientIds: [],
      openSearchCorroborated: true,
      liveClients: [
        {
          id: 'client-os',
          name: 'AmazonOpenSearchService-mydomain-us-east-1',
          label: 'AmazonOpenSearchService-mydomain-us-east-1',
        },
      ],
    });
    expect(added).toEqual([]);
  });

  it('surfaces an ordinary-named undeclared client regardless of corroboration (unchanged)', () => {
    const added = diffUserPoolChildren({
      userPoolId: POOL,
      declaredClientIds: [],
      openSearchCorroborated: false,
      liveClients: [{ id: 'client-rogue', name: 'RogueClient', label: 'RogueClient' }],
    });
    expect(added).toEqual([
      {
        resourceType: 'AWS::Cognito::UserPoolClient',
        identifier: `${POOL}|client-rogue`,
        label: 'RogueClient',
        live: { ClientId: 'client-rogue' },
      },
    ]);
  });

  it('a declared service-prefixed client is matched by id first — never surfaces', () => {
    // The declared-set match happens before the name/corroboration check, so a declared
    // client is never re-flagged even when corroboration is false.
    expect(
      diffUserPoolChildren({
        userPoolId: POOL,
        declaredClientIds: ['client-declared'],
        openSearchCorroborated: false,
        liveClients: [
          {
            id: 'client-declared',
            name: 'AmazonOpenSearchService-declared',
            label: 'Declared',
          },
        ],
      })
    ).toEqual([]);
  });
});
