import {
  DescribeClustersCommand,
  DAXClient,
  ListTagsCommand as DaxListTagsCommand,
} from '@aws-sdk/client-dax';
import { GetLifecyclePolicyCommand, DLMClient } from '@aws-sdk/client-dlm';
import {
  DescribeCacheParameterGroupsCommand,
  DescribeCacheParametersCommand,
  ElastiCacheClient,
  ListTagsForResourceCommand as ElastiCacheListTagsForResourceCommand,
} from '@aws-sdk/client-elasticache';
import {
  GetTagsCommand as GlueGetTagsCommand,
  GetWorkflowCommand,
  GlueClient,
} from '@aws-sdk/client-glue';
import {
  GetJobTemplateCommand,
  GetQueueCommand,
  ListTagsForResourceCommand as MediaConvertListTagsForResourceCommand,
  MediaConvertClient,
} from '@aws-sdk/client-mediaconvert';
import {
  GetNamespaceCommand,
  GetServiceCommand,
  ListTagsForResourceCommand as ServiceDiscoveryListTagsForResourceCommand,
  ServiceDiscoveryClient,
} from '@aws-sdk/client-servicediscovery';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { SDK_OVERRIDES } from '../src/read/overrides.js';

// #1362 — several SDK_OVERRIDES readers never projected the resource's live `Tags`, so a
// declared `Tags` value had no live counterpart (actual=undefined) → a FALSE `declared`-tier
// drift on every check that SURVIVES record, and an out-of-band tag change was invisible. This
// is the #1056 class already fixed for CodeBuild/ACM/DMS/DocDB. Each fixed reader now fetches
// the live tags and, on a tag-fetch FAILURE, MIRRORS the declared Tags + warns (so an omission
// is not a silent FP). List-shape CFn types produce [{Key, Value}]; map-shape produce {k:v}.

const dax = mockClient(DAXClient);
const dlm = mockClient(DLMClient);
const elasticache = mockClient(ElastiCacheClient);
const glue = mockClient(GlueClient);
const mediaconvert = mockClient(MediaConvertClient);
const servicediscovery = mockClient(ServiceDiscoveryClient);

const ctx = (declared: Record<string, unknown>, physicalId = '', accountId = '123456789012') => ({
  physicalId,
  declared,
  region: 'us-east-1',
  accountId,
});

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  dax.reset();
  dlm.reset();
  elasticache.reset();
  glue.reset();
  mediaconvert.reset();
  servicediscovery.reset();
  warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});
afterEach(() => {
  warn.mockRestore();
});

describe('DLM LifecyclePolicy Tags (#1362)', () => {
  it('projects Policy.Tags (map) as the CFn list shape so a declared Tags is not false drift', async () => {
    dlm.on(GetLifecyclePolicyCommand).resolves({
      Policy: {
        Description: 'p',
        State: 'ENABLED',
        ExecutionRoleArn: 'arn:aws:iam::123456789012:role/dlm',
        PolicyDetails: {},
        Tags: { env: 'prod', team: 'data' },
      },
    });
    const out = await SDK_OVERRIDES['AWS::DLM::LifecyclePolicy'](
      ctx(
        {
          Tags: [
            { Key: 'env', Value: 'prod' },
            { Key: 'team', Value: 'data' },
          ],
        },
        'policy-abc'
      )
    );
    expect(out?.Tags).toEqual([
      { Key: 'env', Value: 'prod' },
      { Key: 'team', Value: 'data' },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('omits Tags when the policy carries none (untagged stays clean)', async () => {
    dlm.on(GetLifecyclePolicyCommand).resolves({
      Policy: { Description: 'p', State: 'ENABLED', PolicyDetails: {} },
    });
    const out = await SDK_OVERRIDES['AWS::DLM::LifecyclePolicy'](ctx({}, 'policy-abc'));
    expect(out?.Tags).toBeUndefined();
  });
});

describe('ServiceDiscovery Namespace Tags (#1362)', () => {
  it('projects live tags (list shape) via ListTagsForResource so no false drift', async () => {
    servicediscovery.on(GetNamespaceCommand).resolves({
      Namespace: {
        Name: 'ns',
        Arn: 'arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-x',
        Id: 'ns-x',
      },
    });
    servicediscovery
      .on(ServiceDiscoveryListTagsForResourceCommand)
      .resolves({ Tags: [{ Key: 'env', Value: 'prod' }] });
    const out = await SDK_OVERRIDES['AWS::ServiceDiscovery::PrivateDnsNamespace'](
      ctx({ Tags: [{ Key: 'env', Value: 'prod' }] }, 'ns-x')
    );
    expect(out?.Tags).toEqual([{ Key: 'env', Value: 'prod' }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('mirrors declared Tags + warns when ListTagsForResource fails', async () => {
    servicediscovery.on(GetNamespaceCommand).resolves({
      Namespace: {
        Name: 'ns',
        Arn: 'arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-x',
        Id: 'ns-x',
      },
    });
    servicediscovery
      .on(ServiceDiscoveryListTagsForResourceCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const out = await SDK_OVERRIDES['AWS::ServiceDiscovery::PrivateDnsNamespace'](
      ctx({ Tags: [{ Key: 'env', Value: 'prod' }] }, 'ns-x')
    );
    expect(out?.Tags).toEqual([{ Key: 'env', Value: 'prod' }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('servicediscovery:ListTagsForResource');
  });
});

describe('ServiceDiscovery Service Tags (#1362)', () => {
  it('projects live tags (list shape) so no false drift', async () => {
    servicediscovery.on(GetServiceCommand).resolves({
      Service: {
        Name: 'svc',
        Arn: 'arn:aws:servicediscovery:us-east-1:123456789012:service/srv-x',
        Type: 'HTTP',
      },
    });
    servicediscovery
      .on(ServiceDiscoveryListTagsForResourceCommand)
      .resolves({ Tags: [{ Key: 'app', Value: 'web' }] });
    const out = await SDK_OVERRIDES['AWS::ServiceDiscovery::Service'](
      ctx({ Tags: [{ Key: 'app', Value: 'web' }] }, 'srv-x')
    );
    expect(out?.Tags).toEqual([{ Key: 'app', Value: 'web' }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('mirrors declared Tags + warns on failure', async () => {
    servicediscovery.on(GetServiceCommand).resolves({
      Service: {
        Name: 'svc',
        Arn: 'arn:aws:servicediscovery:us-east-1:123456789012:service/srv-x',
        Type: 'HTTP',
      },
    });
    servicediscovery.on(ServiceDiscoveryListTagsForResourceCommand).rejects(new Error('boom'));
    const out = await SDK_OVERRIDES['AWS::ServiceDiscovery::Service'](
      ctx({ Tags: [{ Key: 'app', Value: 'web' }] }, 'srv-x')
    );
    expect(out?.Tags).toEqual([{ Key: 'app', Value: 'web' }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('ElastiCache ParameterGroup Tags (#1362)', () => {
  it('projects live tags (list shape) via ListTagsForResource so no false drift', async () => {
    elasticache.on(DescribeCacheParameterGroupsCommand).resolves({
      CacheParameterGroups: [
        {
          CacheParameterGroupName: 'pg',
          CacheParameterGroupFamily: 'redis7',
          Description: 'd',
        },
      ],
    });
    elasticache.on(DescribeCacheParametersCommand).resolves({ Parameters: [] });
    elasticache
      .on(ElastiCacheListTagsForResourceCommand)
      .resolves({ TagList: [{ Key: 'env', Value: 'prod' }] });
    const out = await SDK_OVERRIDES['AWS::ElastiCache::ParameterGroup'](
      ctx({ Tags: [{ Key: 'env', Value: 'prod' }] }, 'pg')
    );
    expect(out?.Tags).toEqual([{ Key: 'env', Value: 'prod' }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('mirrors declared Tags + warns when ListTagsForResource fails', async () => {
    elasticache.on(DescribeCacheParameterGroupsCommand).resolves({
      CacheParameterGroups: [{ CacheParameterGroupName: 'pg', Description: 'd' }],
    });
    elasticache.on(DescribeCacheParametersCommand).resolves({ Parameters: [] });
    elasticache
      .on(ElastiCacheListTagsForResourceCommand)
      .rejects(Object.assign(new Error('nope'), { name: 'AccessDeniedException' }));
    const out = await SDK_OVERRIDES['AWS::ElastiCache::ParameterGroup'](
      ctx({ Tags: [{ Key: 'env', Value: 'prod' }] }, 'pg')
    );
    expect(out?.Tags).toEqual([{ Key: 'env', Value: 'prod' }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('elasticache:ListTagsForResource');
  });
});

describe('DAX Cluster Tags (#1362)', () => {
  it('projects live tags (SDK list) folded to the CFn map shape so no false drift', async () => {
    dax.on(DescribeClustersCommand).resolves({
      Clusters: [
        {
          ClusterName: 'c',
          NodeType: 'dax.r4.large',
          ClusterArn: 'arn:aws:dax:us-east-1:123456789012:cache/c',
        },
      ],
    });
    dax.on(DaxListTagsCommand).resolves({
      Tags: [
        { Key: 'env', Value: 'prod' },
        { Key: 'team', Value: 'data' },
      ],
    });
    const out = await SDK_OVERRIDES['AWS::DAX::Cluster'](
      ctx({ Tags: { env: 'prod', team: 'data' } }, 'c')
    );
    expect(out?.Tags).toEqual({ env: 'prod', team: 'data' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('mirrors declared Tags (map) + warns when ListTags fails', async () => {
    dax.on(DescribeClustersCommand).resolves({
      Clusters: [
        {
          ClusterName: 'c',
          NodeType: 'dax.r4.large',
          ClusterArn: 'arn:aws:dax:us-east-1:123456789012:cache/c',
        },
      ],
    });
    dax
      .on(DaxListTagsCommand)
      .rejects(Object.assign(new Error('x'), { name: 'AccessDeniedException' }));
    const out = await SDK_OVERRIDES['AWS::DAX::Cluster'](ctx({ Tags: { env: 'prod' } }, 'c'));
    expect(out?.Tags).toEqual({ env: 'prod' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('dax:ListTags');
  });
});

describe('Glue Workflow Tags (#1362)', () => {
  it('projects live tags (map shape) via GetTags so no false drift', async () => {
    glue.on(GetWorkflowCommand).resolves({ Workflow: { Name: 'wf', Description: 'd' } });
    glue.on(GlueGetTagsCommand).resolves({ Tags: { env: 'prod' } });
    const out = await SDK_OVERRIDES['AWS::Glue::Workflow'](ctx({ Tags: { env: 'prod' } }, 'wf'));
    expect(out?.Tags).toEqual({ env: 'prod' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('mirrors declared Tags (map) + warns when GetTags fails', async () => {
    glue.on(GetWorkflowCommand).resolves({ Workflow: { Name: 'wf', Description: 'd' } });
    glue
      .on(GlueGetTagsCommand)
      .rejects(Object.assign(new Error('x'), { name: 'AccessDeniedException' }));
    const out = await SDK_OVERRIDES['AWS::Glue::Workflow'](ctx({ Tags: { env: 'prod' } }, 'wf'));
    expect(out?.Tags).toEqual({ env: 'prod' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('glue:GetTags');
  });
});

describe('MediaConvert Queue / JobTemplate Tags (#1362)', () => {
  it('Queue: projects live tags (map shape) via ListTagsForResource so no false drift', async () => {
    mediaconvert.on(GetQueueCommand).resolves({
      Queue: { Name: 'q', Arn: 'arn:aws:mediaconvert:us-east-1:123456789012:queues/q' },
    });
    mediaconvert
      .on(MediaConvertListTagsForResourceCommand)
      .resolves({ ResourceTags: { Tags: { env: 'prod' } } });
    const out = await SDK_OVERRIDES['AWS::MediaConvert::Queue'](
      ctx({ Tags: { env: 'prod' } }, 'q')
    );
    expect(out?.Tags).toEqual({ env: 'prod' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('JobTemplate: projects live tags (map shape) so no false drift', async () => {
    mediaconvert.on(GetJobTemplateCommand).resolves({
      JobTemplate: {
        Name: 'jt',
        Arn: 'arn:aws:mediaconvert:us-east-1:123456789012:jobTemplates/jt',
      },
    } as never);
    mediaconvert
      .on(MediaConvertListTagsForResourceCommand)
      .resolves({ ResourceTags: { Tags: { app: 'web' } } });
    const out = await SDK_OVERRIDES['AWS::MediaConvert::JobTemplate'](
      ctx({ Tags: { app: 'web' } }, 'jt')
    );
    expect(out?.Tags).toEqual({ app: 'web' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('mirrors declared Tags (map) + warns when ListTagsForResource fails', async () => {
    mediaconvert.on(GetQueueCommand).resolves({
      Queue: { Name: 'q', Arn: 'arn:aws:mediaconvert:us-east-1:123456789012:queues/q' },
    });
    mediaconvert
      .on(MediaConvertListTagsForResourceCommand)
      .rejects(Object.assign(new Error('x'), { name: 'AccessDeniedException' }));
    const out = await SDK_OVERRIDES['AWS::MediaConvert::Queue'](
      ctx({ Tags: { env: 'prod' } }, 'q')
    );
    expect(out?.Tags).toEqual({ env: 'prod' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('mediaconvert:ListTagsForResource');
  });
});
