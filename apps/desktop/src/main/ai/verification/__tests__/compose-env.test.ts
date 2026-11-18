import { describe, expect, it } from 'vitest';

import { composeEnv } from '../compose-env';
import { type ComposeService, composeServices, type StartedComposeService } from '../compose-services';

const COMPOSE = `
services:
  rabbitmq:
    image: rabbitmq:3-management
    ports: ["5672:5672", "15672:15672"]
    environment:
      RABBITMQ_DEFAULT_USER: app
      RABBITMQ_DEFAULT_PASS: apppass
  minio:
    image: minio/minio
    command: server /data
    ports: ["9000:9000"]
  kafka:
    image: bitnami/kafka:3.7
    ports: ["9092:9092"]
  elasticsearch:
    image: elasticsearch:8.13.0
    ports: ["9200:9200"]
  meili:
    image: getmeili/meilisearch
    environment:
      MEILI_MASTER_KEY: masterkey
`;

const planned = composeServices([COMPOSE]);
const startedAs = (service: ComposeService, ports: Record<number, number>, env: Record<string, string> = service.env): StartedComposeService => ({
  name: service.name, kind: service.kind, image: service.image, ports, env,
});
const byName = (name: string) => planned.find((s) => s.name === name) as ComposeService;
const started = [
  startedAs(byName('rabbitmq'), { 5672: 50001, 15672: 50002 }),
  startedAs(byName('minio'), { 9000: 50003 }),
  startedAs(byName('kafka'), { 9092: 50004 }),
  startedAs(byName('elasticsearch'), { 9200: 50005 }),
  startedAs(byName('meili'), { 7700: 50006 }),
];
const values = (example: string, run = started) => Object.fromEntries([...composeEnv(example, { planned, started: run })].map(([name, v]) => [name, v.value]));

describe('composeEnv', () => {
  it('points a URL at a service by its compose name to its local port, with the credentials it started with', () => {
    expect(values('AMQP_URL=amqp://guest:guest@rabbitmq:5672/vhost')).toEqual({ AMQP_URL: 'amqp://app:apppass@127.0.0.1:50001/vhost' });
  });

  it('points localhost at the service compose publishes on that port', () => {
    expect(values('S3_ENDPOINT=http://localhost:9000\nRABBITMQ_MANAGEMENT=http://127.0.0.1:15672/api')).toEqual({
      S3_ENDPOINT: 'http://127.0.0.1:50003',
      RABBITMQ_MANAGEMENT: 'http://127.0.0.1:50002/api',
    });
  });

  it('adds the port to an address that leaves it to the scheme', () => {
    expect(values('ELASTICSEARCH_URL=http://elasticsearch')).toEqual({ ELASTICSEARCH_URL: 'http://127.0.0.1:50005' });
  });

  it('serves a search engine without TLS as http', () => {
    expect(values('ELASTICSEARCH_URL=https://elastic:changeme@localhost:9200')).toEqual({ ELASTICSEARCH_URL: 'http://elastic:changeme@127.0.0.1:50005' });
  });

  it('points bare host:port lists at the service', () => {
    expect(values('KAFKA_BROKERS=kafka:9092\nKAFKA_BOOTSTRAP_SERVERS=localhost:9092,kafka:9092')).toEqual({
      KAFKA_BROKERS: '127.0.0.1:50004',
      KAFKA_BOOTSTRAP_SERVERS: '127.0.0.1:50004',
    });
  });

  it('pairs a HOST and a PORT setting by the service their name names', () => {
    expect(values('RABBITMQ_HOST=localhost\nRABBITMQ_PORT=5672\nES_HOST=elasticsearch\nES_PORT=9200\nAPP_HOST=localhost\nAPP_PORT=3000')).toEqual({
      RABBITMQ_HOST: '127.0.0.1', RABBITMQ_PORT: '50001', ES_HOST: '127.0.0.1', ES_PORT: '50005',
    });
  });

  it('leaves a value that only happens to equal a service name', () => {
    expect(values('STORAGE_DRIVER=minio\nQUEUE=rabbitmq')).toEqual({});
  });

  it('fills S3 settings from the MinIO container: endpoint, keys, path style, no SSL', () => {
    expect(values('AWS_ACCESS_KEY_ID=\nAWS_SECRET_ACCESS_KEY=\nAWS_SESSION_TOKEN=abc\nS3_FORCE_PATH_STYLE=false\nAWS_ENDPOINT_URL=\nMINIO_ENDPOINT=localhost\nMINIO_PORT=9000\nMINIO_USE_SSL=true\nAWS_REGION=eu-west-1\nS3_BUCKET=uploads')).toEqual({
      AWS_ACCESS_KEY_ID: 'minioadmin',
      AWS_SECRET_ACCESS_KEY: 'minioadmin',
      AWS_SESSION_TOKEN: '',
      S3_FORCE_PATH_STYLE: 'true',
      AWS_ENDPOINT_URL: 'http://127.0.0.1:50003',
      MINIO_ENDPOINT: '127.0.0.1',
      MINIO_PORT: '50003',
      MINIO_USE_SSL: 'false',
    });
  });

  it('gives the search keys the container started with', () => {
    expect(values('MEILI_MASTER_KEY=change-me\nMEILISEARCH_HOST=http://localhost:7700')).toEqual({
      MEILI_MASTER_KEY: 'masterkey',
      MEILISEARCH_HOST: 'http://127.0.0.1:50006',
    });
  });

  it('gives RabbitMQ\'s user settings the ones it started with, and keeps the example\'s when compose sets none', () => {
    expect(values('RABBITMQ_USER=guest\nRABBITMQ_PASSWORD=guest')).toEqual({ RABBITMQ_USER: 'app', RABBITMQ_PASSWORD: 'apppass' });
    const plain = composeServices(['services:\n  rabbitmq:\n    image: rabbitmq:3\n']);
    const run = [{ name: 'rabbitmq', kind: 'rabbitmq' as const, image: 'rabbitmq:3', ports: { 5672: 50001 }, env: {} }];
    const wired = composeEnv('AMQP_URL=amqp://guest:guest@rabbitmq:5672\nRABBITMQ_USER=guest', { planned: plain, started: run });
    expect(Object.fromEntries([...wired].map(([n, v]) => [n, v.value]))).toEqual({ AMQP_URL: 'amqp://guest:guest@127.0.0.1:50001' });
  });

  it('empties what points at a service that did not start, and says which', () => {
    const wired = composeEnv('AMQP_URL=amqp://rabbitmq:5672\nS3_ENDPOINT=http://localhost:9000\nAWS_ACCESS_KEY_ID=x', { planned, started: [] });
    expect([...wired]).toEqual([
      ['AMQP_URL', { value: '', service: 'rabbitmq', started: false }],
      ['S3_ENDPOINT', { value: '', service: 'minio', started: false }],
      ['AWS_ACCESS_KEY_ID', { value: '', service: 'minio', started: false }],
    ]);
  });

  it('names the service each value comes from', () => {
    expect(composeEnv('AMQP_URL=amqp://rabbitmq', { planned, started }).get('AMQP_URL')).toEqual({ value: 'amqp://127.0.0.1:50001', service: 'rabbitmq', started: true });
  });

  it('touches nothing that points elsewhere', () => {
    expect(values('API_URL=http://localhost:3000\nSENTRY_DSN=https://k@sentry.io/1\nREAL=amqp://broker.example.com:5672')).toEqual({});
  });

  it('does nothing without compose services', () => {
    expect(composeEnv('AMQP_URL=amqp://rabbitmq', { planned: [], started: [] }).size).toBe(0);
  });
});
