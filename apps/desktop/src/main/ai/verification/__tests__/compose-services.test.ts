import { describe, expect, it } from 'vitest';

import { bucketsOf, composeServices, containerSpec, dependencyOrder } from '../compose-services';

const compose = (text: string) => composeServices([text]);
const secret = () => 'generated';

describe('composeServices', () => {
  it('takes every service with an image and no build, except the databases test-services starts', () => {
    const services = compose(`
services:
  api:
    build: .
    image: myapp/api:dev
  db:
    image: postgres:16
  cache:
    image: redis:7
  rabbitmq:
    image: rabbitmq:3-management
  minio:
    image: minio/minio:latest
`);
    expect(services.map((s) => [s.name, s.kind])).toEqual([['rabbitmq', 'rabbitmq'], ['minio', 's3']]);
  });

  it('knows the kinds with adapters by image', () => {
    const services = compose(`
services:
  kafka: { image: bitnami/kafka:3.7 }
  broker: { image: confluentinc/cp-kafka:7.6.0 }
  redpanda: { image: docker.redpanda.com/redpandadata/redpanda:v24.1.1 }
  es: { image: docker.elastic.co/elasticsearch/elasticsearch:8.13.0 }
  os: { image: opensearchproject/opensearch:2 }
  meili: { image: getmeili/meilisearch:v1.8 }
  ts: { image: typesense/typesense:26.0 }
  localstack: { image: localstack/localstack }
  jaeger: { image: jaegertracing/all-in-one:1.57 }
`);
    expect(Object.fromEntries(services.map((s) => [s.name, s.kind]))).toEqual({
      kafka: 'kafka', broker: 'kafka', redpanda: 'redpanda', es: 'elasticsearch', os: 'opensearch',
      meili: 'meilisearch', ts: 'typesense', localstack: 's3', jaeger: 'generic',
    });
  });

  it('leaves out tools that only look at other services, mail catchers and proxies', () => {
    const services = compose(`
services:
  adminer: { image: adminer }
  ui: { image: provectuslabs/kafka-ui }
  mail: { image: axllent/mailpit }
  proxy: { image: nginx:1.27 }
  kibana: { image: docker.elastic.co/kibana/kibana:8.13.0 }
  nats: { image: nats:2.10 }
`);
    expect(services.map((s) => s.name)).toEqual(['nats']);
  });

  it('leaves out services behind a profile, scaled to zero, or with an unsafe image or name', () => {
    const services = compose(`
services:
  debug:
    image: nats:2
    profiles: [debug]
  off:
    image: nats:2
    scale: 0
  bad:
    image: "nats:2 --privileged"
  ok:
    image: nats:2
`);
    expect(services.map((s) => s.name)).toEqual(['ok']);
  });

  it('takes the environment as values only, never env_file or the host\'s values', () => {
    const [service] = compose(`
services:
  rabbitmq:
    image: rabbitmq:3
    env_file: .env
    environment:
      RABBITMQ_DEFAULT_USER: app
      RABBITMQ_DEFAULT_PASS: \${RABBIT_PASS:-secret}
      FROM_HOST:
      REQUIRED: \${NOT_SET:?set it}
      COST: $$5
`);
    expect(service.env).toEqual({ RABBITMQ_DEFAULT_USER: 'app', RABBITMQ_DEFAULT_PASS: 'secret', REQUIRED: '', COST: '$5' });
  });

  it('reads a list environment and dotted names', () => {
    const [service] = compose(`
services:
  es:
    image: elasticsearch:8.13.0
    environment:
      - discovery.type=single-node
      - ES_JAVA_OPTS=-Xms1g -Xmx1g
      - PASSTHROUGH
`);
    expect(service.env).toEqual({ 'discovery.type': 'single-node', ES_JAVA_OPTS: '-Xms1g -Xmx1g' });
  });

  it('takes the container ports from ports and expose, tcp only, with the host port compose names', () => {
    const [service] = compose(`
services:
  minio:
    image: minio/minio
    ports:
      - "9000:9000"
      - "127.0.0.1:19001:9001"
      - "5000"
      - "6000/udp"
      - target: 7000
        published: 17000
    expose:
      - "8000"
      - 9000
`);
    expect(service.ports).toEqual([
      { container: 9000, host: 9000 },
      { container: 9001, host: 19001 },
      { container: 5000 },
      { container: 7000, host: 17000 },
      { container: 8000 },
    ]);
  });

  it('splits a string command like a shell and keeps a list one', () => {
    const [minio, meili] = compose(`
services:
  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
  meili:
    image: getmeili/meilisearch
    entrypoint: ["/bin/meilisearch", "--no-analytics"]
`);
    expect(minio.command).toEqual(['server', '/data', '--console-address', ':9001']);
    expect(meili.entrypoint).toEqual(['/bin/meilisearch', '--no-analytics']);
  });

  it('reads the healthcheck as a command to run in the container', () => {
    const [a, b, c, d] = compose(`
services:
  a:
    image: nats:2
    healthcheck: { test: ["CMD", "wget", "-q", "localhost:8222/healthz"] }
  b:
    image: nats:2
    healthcheck: { test: ["CMD-SHELL", "curl -f localhost || exit 1"] }
  c:
    image: nats:2
    healthcheck: { test: "true" }
  d:
    image: nats:2
    healthcheck: { disable: true, test: ["CMD", "x"] }
`);
    expect(a.healthcheck).toEqual(['wget', '-q', 'localhost:8222/healthz']);
    expect(b.healthcheck).toEqual(['sh', '-c', 'curl -f localhost || exit 1']);
    expect(c.healthcheck).toEqual(['sh', '-c', 'true']);
    expect(d.healthcheck).toBeUndefined();
  });

  it('never carries volumes, privileges, devices, the host network, a user or extra hosts', () => {
    const [service] = compose(`
services:
  evil:
    image: nats:2
    privileged: true
    cap_add: [ALL]
    devices: ["/dev/sda:/dev/sda"]
    network_mode: host
    pid: host
    ipc: host
    user: root
    security_opt: ["seccomp:unconfined"]
    extra_hosts: ["api.real.com:10.0.0.1"]
    volumes: ["/:/host", "/var/run/docker.sock:/var/run/docker.sock"]
`);
    expect(Object.keys(service).sort()).toEqual(['dependsOn', 'env', 'image', 'kind', 'name', 'ports']);
  });

  it('merges the override files onto the main one, and an override build makes it the project\'s code', () => {
    const services = composeServices([
      'services:\n  rabbitmq:\n    image: rabbitmq:3\n    environment:\n      A: "1"\n  search:\n    image: getmeili/meilisearch\n',
      'services:\n  rabbitmq:\n    environment:\n      B: "2"\n  search:\n    build: ./search\n',
    ]);
    expect(services.map((s) => s.name)).toEqual(['rabbitmq']);
    expect(services[0].env).toEqual({ A: '1', B: '2' });
  });

  it('ignores a file that is not YAML', () => {
    expect(composeServices(['services: [', 'services:\n  nats:\n    image: nats:2\n']).map((s) => s.name)).toEqual(['nats']);
  });
});

describe('dependencyOrder', () => {
  it('starts what a service depends on first', () => {
    const services = compose(`
services:
  kafka:
    image: confluentinc/cp-kafka
    depends_on: [zookeeper]
  zookeeper:
    image: confluentinc/cp-zookeeper
`);
    expect(dependencyOrder(services).map((s) => s.name)).toEqual(['zookeeper', 'kafka']);
  });
});

describe('containerSpec', () => {
  const one = (text: string) => compose(text)[0];

  it('publishes each container port, or the kind\'s own when compose names none', () => {
    expect(containerSpec(one('services:\n  rabbitmq:\n    image: rabbitmq:3\n'), { secret }).publish).toEqual([{ container: 5672 }]);
    expect(containerSpec(one('services:\n  x:\n    image: nats:2\n    expose: ["4222", "8222"]\n'), { secret }).publish).toEqual([{ container: 4222 }, { container: 8222 }]);
  });

  it('runs Elasticsearch as one node without security, and OpenSearch too', () => {
    const es = containerSpec(one('services:\n  es:\n    image: elasticsearch:8.13.0\n    environment:\n      xpack.security.enabled: "true"\n'), { secret });
    expect(es.env).toMatchObject({ 'discovery.type': 'single-node', 'xpack.security.enabled': 'false' });
    expect(es.env.ES_JAVA_OPTS).toMatch(/-Xmx/);
    const os = containerSpec(one('services:\n  os:\n    image: opensearchproject/opensearch:2\n'), { secret });
    expect(os.env).toMatchObject({ 'discovery.type': 'single-node', DISABLE_SECURITY_PLUGIN: 'true', DISABLE_INSTALL_DEMO_CONFIG: 'true' });
  });

  it('gives Meilisearch and Typesense a master key when compose sets none, and keeps the one it sets', () => {
    expect(containerSpec(one('services:\n  m:\n    image: getmeili/meilisearch\n'), { secret }).env.MEILI_MASTER_KEY).toBe('generated');
    expect(containerSpec(one('services:\n  m:\n    image: getmeili/meilisearch\n    environment:\n      MEILI_MASTER_KEY: own\n'), { secret }).env.MEILI_MASTER_KEY).toBe('own');
    const ts = containerSpec(one('services:\n  t:\n    image: typesense/typesense:26.0\n'), { secret });
    expect(ts.env).toMatchObject({ TYPESENSE_API_KEY: 'generated', TYPESENSE_DATA_DIR: '/tmp' });
    const fromCommand = containerSpec(one('services:\n  t:\n    image: typesense/typesense:26.0\n    command: --data-dir /data --api-key=xyz\n'), { secret });
    expect(fromCommand.env.TYPESENSE_API_KEY).toBe('xyz');
    expect(fromCommand.env.TYPESENSE_DATA_DIR).toBeUndefined();
  });

  it('advertises Kafka at the host port chosen for it, keeping the internal listeners', () => {
    const spec = containerSpec(one(`
services:
  kafka:
    image: bitnami/kafka:3.7
    ports: ["9092:9092"]
    environment:
      KAFKA_CFG_LISTENERS: PLAINTEXT://:29092,CONTROLLER://:9093,PLAINTEXT_HOST://:9092
      KAFKA_CFG_ADVERTISED_LISTENERS: PLAINTEXT://kafka:29092,PLAINTEXT_HOST://localhost:9092
`), { secret, hostPort: 41000 });
    expect(spec.env.KAFKA_CFG_ADVERTISED_LISTENERS).toBe('PLAINTEXT://kafka:29092,PLAINTEXT_HOST://127.0.0.1:41000');
    expect(spec.env.KAFKA_CFG_LISTENERS).toBe('PLAINTEXT://:29092,CONTROLLER://:9093,PLAINTEXT_HOST://0.0.0.0:41000');
    expect(spec.publish).toEqual([{ container: 41000, host: 41000 }]);
  });

  it('configures a single-node Kafka when compose says nothing about its listeners', () => {
    const spec = containerSpec(one('services:\n  kafka:\n    image: apache/kafka:3.7.0\n'), { secret, hostPort: 41000 });
    expect(spec.env).toMatchObject({
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_LISTENERS: 'PLAINTEXT://0.0.0.0:41000,CONTROLLER://0.0.0.0:9093',
      KAFKA_ADVERTISED_LISTENERS: 'PLAINTEXT://127.0.0.1:41000',
    });
  });

  it('advertises Redpanda at the host port chosen for it', () => {
    const spec = containerSpec(one(`
services:
  redpanda:
    image: redpandadata/redpanda:v24.1.1
    command: redpanda start --kafka-addr internal://0.0.0.0:9092,external://0.0.0.0:19092 --advertise-kafka-addr=internal://redpanda:9092,external://localhost:19092
`), { secret, hostPort: 41000 });
    expect(spec.command).toEqual([
      'redpanda', 'start',
      '--kafka-addr', 'internal://0.0.0.0:9092,external://0.0.0.0:41000',
      '--advertise-kafka-addr=internal://redpanda:9092,external://127.0.0.1:41000',
    ]);
    const bare = containerSpec(one('services:\n  redpanda:\n    image: redpandadata/redpanda\n'), { secret, hostPort: 41000 });
    expect(bare.command).toContain('127.0.0.1:41000');
  });
});

describe('bucketsOf', () => {
  it('names the buckets the example settings use, valid names only', () => {
    expect(bucketsOf('S3_BUCKET=uploads\nAWS_BUCKET_NAME="media.files"\nOTHER_BUCKET=Bad_Name\nNAME=x')).toEqual(['uploads', 'media.files']);
  });
});
