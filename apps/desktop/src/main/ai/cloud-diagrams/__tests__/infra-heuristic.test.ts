import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CLOUD_DESIGN_MARKER, concernsCloudInfra, findTerraformFiles } from '../infra-heuristic';

describe('concernsCloudInfra', () => {
  it('is yes for a spec that names a cloud, Terraform or infrastructure as code', () => {
    for (const text of [
      'Deploy the API to AWS Lambda behind API Gateway',
      'Host the web app on Azure App Service with Entra ID sign-in',
      'Move the workers to Google Cloud Run',
      'Add a Terraform module for the queue',
      'Change main.tf to add a bucket',
      'Describe the infrastructure as code for staging',
      'Put the database in a private subnet of the VPC',
      'Run it on Kubernetes (EKS)',
    ]) {
      expect(concernsCloudInfra({ text, projectHasTerraform: false }), text).toBe(true);
    }
  });

  it('is no for an ordinary feature, even one that says "deploy" in passing, in a project without Terraform', () => {
    for (const text of [
      'Add a dark mode toggle to the settings page',
      'Fix the date picker in the booking form',
      'Users can export their notes as PDF; deploy as usual',
      'The awesome sidebar should collapse', // "aws" inside a word
    ]) {
      expect(concernsCloudInfra({ text, projectHasTerraform: false }), text).toBe(false);
    }
  });

  it('in a project with Terraform, a spec about deployment, hosting or infrastructure counts too', () => {
    expect(concernsCloudInfra({ text: 'Add a staging environment and deploy to it', projectHasTerraform: true })).toBe(true);
    expect(concernsCloudInfra({ text: 'Scale the database for more traffic; infrastructure changes', projectHasTerraform: true })).toBe(true);
    expect(concernsCloudInfra({ text: 'Add a dark mode toggle', projectHasTerraform: true })).toBe(false);
  });

  it('always counts a task the app created to design the cloud architecture', () => {
    expect(concernsCloudInfra({ text: `Something\n${CLOUD_DESIGN_MARKER}`, projectHasTerraform: false })).toBe(true);
  });
});

describe('findTerraformFiles', () => {
  it('finds .tf files a few levels down, skipping dependency, build and hidden folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'vtl-tf-'));
    mkdirSync(join(root, 'infra', 'envs', 'prod'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
    mkdirSync(join(root, '.terraform', 'modules'), { recursive: true });
    writeFileSync(join(root, 'infra', 'envs', 'prod', 'main.tf'), '');
    writeFileSync(join(root, 'node_modules', 'x', 'bad.tf'), '');
    writeFileSync(join(root, '.terraform', 'modules', 'bad.tf'), '');
    expect(findTerraformFiles(root)).toEqual([join('infra', 'envs', 'prod', 'main.tf')]);
  });

  it('is empty for a project without Terraform, or a missing folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'vtl-tf-'));
    writeFileSync(join(root, 'index.ts'), '');
    expect(findTerraformFiles(root)).toEqual([]);
    expect(findTerraformFiles(join(root, 'nope'))).toEqual([]);
  });
});
