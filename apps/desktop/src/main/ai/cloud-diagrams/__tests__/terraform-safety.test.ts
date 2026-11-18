import { describe, expect, it } from 'vitest';

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readHcl, terraformUnsafe, walkTerraformFiles } from '../terraform-safety';

const file = (path: string, text: string) => ({ path, text });

const SAFE = `
# A comment with provisioner "local-exec" and data "external" in it
terraform {
  required_version = ">= 1.5"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
    random = {
      source = "registry.opentofu.org/hashicorp/random"
    }
    azuread = "~> 2.0"
  }
  backend "azurerm" {
    resource_group_name = "tf"
  }
}

provider "azurerm" {
  features {}
}

module "network" {
  source = "./modules/network"
}

locals {
  tags = { env = var.env, name = "\${var.name}-app" }
  policy = <<EOT
{ "unbalanced": [ "fine in a heredoc" }
EOT
}

variable "env" {
  type    = string
  default = "dev"
}

resource "azurerm_resource_group" "rg" {
  name     = "rg-\${local.tags.env}"
  location = "westeurope"
  tags     = local.tags
  lifecycle {
    ignore_changes = [tags]
  }
}

resource "azurerm_storage_account" "sa" {
  count  = var.env == "prod" ? 1 : 0
  name   = "sa\${random_string.s.result}"
  custom = file("\${path.module}/policy.json")
  other  = templatefile("templates/x.tpl", { a = 1 })
}

resource "random_string" "s" {
  length = 6
}

output "rg" {
  value = azurerm_resource_group.rg.name
}
`;

const NETWORK = 'resource "azurerm_virtual_network" "v" {\n  name = "v"\n}\n';

const unsafe = (text: string, path = 'infra/main.tf', extra: { path: string; text: string }[] = []) =>
  terraformUnsafe([file(path, text), ...extra]);

describe('readHcl', () => {
  it('reads blocks with quoted or bare labels, attributes, nested blocks and heredocs', () => {
    const blocks = readHcl(SAFE);
    expect(blocks.map((b) => b.type)).toEqual(['terraform', 'provider', 'module', 'locals', 'variable', 'resource', 'resource', 'resource', 'output']);
    expect(readHcl('data external x {\n}\n')[0]).toMatchObject({ type: 'data', labels: ['external', 'x'] });
  });

  it("refuses what it can't read", () => {
    for (const text of ['resource "a" "b" {', 'resource "a" "b" }', 'x = "unclosed', 'x = (1', 'resource "a" "${x}" {}', '@@@', 'a = 1\na = 2']) {
      expect(() => readHcl(text), text).toThrow();
    }
  });
});

describe('terraformUnsafe: allowed', () => {
  it('accepts vetted providers, their resources, local modules that were checked, and any backend', () => {
    expect(unsafe(SAFE, 'infra/main.tf', [file('infra/modules/network/main.tf', NETWORK)])).toBeUndefined();
  });
});

describe('terraformUnsafe: refused', () => {
  it('data "external" and other providers, quoted or bare', () => {
    expect(unsafe('data "external" "x" {\n  program = ["id"]\n}')).toMatch(/external/);
    expect(unsafe('data external x {\n  program = ["id"]\n}')).toMatch(/external/);
    expect(unsafe('data "local_file" "k" {\n  filename = "x"\n}')).toMatch(/local_file/);
    expect(unsafe('data "http" "x" {\n  url = "https://e"\n}')).toMatch(/http/);
    expect(unsafe('data "terraform_remote_state" "s" {\n  backend = "local"\n}')).toMatch(/terraform_remote_state/);
    expect(unsafe('resource "null_resource" "x" {\n}')).toMatch(/null_resource/);
    expect(unsafe('resource "kubernetes_pod" "x" {\n}')).toMatch(/kubernetes_pod/);
  });

  it('provisioners anywhere, quoted or bare', () => {
    expect(unsafe('resource "aws_instance" "x" {\n  provisioner "local-exec" {\n    command = "id"\n  }\n}')).toMatch(/provisioner/);
    expect(unsafe('resource "aws_instance" "x" {\n  provisioner remote-exec {\n    inline = ["id"]\n  }\n}')).toMatch(/provisioner/);
    expect(unsafe('resource "terraform_data" "x" {\n  provisioner "file" {\n    source = "a"\n  }\n}')).toMatch(/provisioner/);
  });

  it('providers outside the vetted set or from other registries', () => {
    expect(unsafe('provider "kubernetes" {\n}')).toMatch(/kubernetes/);
    expect(unsafe('terraform {\n  required_providers {\n    x = { source = "evil.example.com/org/x" }\n  }\n}')).toMatch(/not a vetted provider/);
    expect(unsafe('terraform {\n  required_providers {\n    aws = { source = "someone/aws" }\n  }\n}')).toMatch(/not a vetted provider/);
    expect(unsafe('terraform {\n  required_providers {\n    external = "~> 2.0"\n  }\n}')).toMatch(/not a vetted provider/);
  });

  it('provider attributes that name files or processes', () => {
    expect(unsafe('provider "aws" {\n  shared_credentials_files = ["./creds"]\n}')).toMatch(/shared_credentials_files/);
    expect(unsafe('provider "aws" {\n  assume_role_with_web_identity {\n    web_identity_token_file = "/x"\n  }\n}')).toMatch(/web_identity_token_file/);
    expect(unsafe('provider "google" {\n  credentials = "credential_process"\n}')).toMatch(/process/);
  });

  it('modules that are not checked folders of the repository', () => {
    for (const source of ['Azure/avm-res-storage-storageaccount/azurerm', 'git::https://example.com/x.git', 'github.com/org/repo', 'https://e/m.zip', '/abs/path']) {
      expect(unsafe(`module "m" {\n  source = "${source}"\n}`), source).toMatch(/module source/);
    }
    expect(unsafe('module "m" {\n  source = "../../../outside"\n}')).toMatch(/outside the repository/);
    expect(unsafe('module "m" {\n  source = "./vendor/m"\n}')).toMatch(/wasn't checked/);
    expect(unsafe('module "m" {\n  source = var.where\n}')).toMatch(/no plain source/);
  });

  it('file functions outside the repository', () => {
    expect(unsafe('locals {\n  k = file("/etc/passwd")\n}')).toMatch(/outside the repository/);
    expect(unsafe('locals {\n  k = file("../../../.ssh/id_rsa")\n}')).toMatch(/outside the repository/);
    expect(unsafe('locals {\n  k = file(var.p)\n}')).toMatch(/literal/);
    expect(unsafe('locals {\n  k = pathexpand("~/x")\n}')).toMatch(/pathexpand/);
    expect(unsafe('locals {\n  k = file("${path.module}/../../x")\n}')).toMatch(/literal/);
  });

  it('unknown top-level blocks, and Terraform JSON or OpenTofu JSON files', () => {
    expect(unsafe('something "x" {\n}')).toMatch(/unrecognised block/);
    expect(terraformUnsafe([file('main.tf.json', '{}')])).toMatch(/JSON/);
    expect(terraformUnsafe([file('main.tofu.json', '{}')])).toMatch(/JSON/);
  });

  it('applies to .tofu files the same way', () => {
    expect(terraformUnsafe([file('main.tofu', 'data "external" "x" {\n}')])).toMatch(/external/);
  });
});

describe('walkTerraformFiles', () => {
  it('finds .tf, .tofu and their JSON forms in every folder but .git, hidden and vendored ones too', () => {
    const root = mkdtempSync(join(tmpdir(), 'vtl-walk-'));
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'vendor', 'm'), { recursive: true });
    mkdirSync(join(root, '.hidden'), { recursive: true });
    writeFileSync(join(root, '.git', 'x.tf'), '');
    writeFileSync(join(root, 'main.tf'), '');
    writeFileSync(join(root, 'vendor', 'm', 'a.tofu'), '');
    writeFileSync(join(root, '.hidden', 'b.tf.json'), '');
    writeFileSync(join(root, 'c.tofu.json'), '');
    expect(walkTerraformFiles(root)).toEqual(['.hidden/b.tf.json', 'c.tofu.json', 'main.tf', 'vendor/m/a.tofu']);
  });

  it('refuses a symbolic link anywhere', () => {
    const root = mkdtempSync(join(tmpdir(), 'vtl-walk-'));
    mkdirSync(join(root, 'infra'));
    symlinkSync(tmpdir(), join(root, 'infra', 'link'));
    expect(() => walkTerraformFiles(root)).toThrow(/symbolic link/);
  });
});
