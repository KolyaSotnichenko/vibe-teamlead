import { describe, expect, it } from 'vitest';

import { terraformUnsafe } from '../terraform-safety';

const file = (path: string, text: string) => ({ path, text });

const SAFE = `
terraform {
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
    random  = { source = "registry.opentofu.org/hashicorp/random" }
  }
  backend "azurerm" {
    resource_group_name = "tf"
  }
}
provider "azurerm" { features {} }
module "network" {
  source = "./modules/network"
}
module "storage" {
  source  = "Azure/avm-res-storage-storageaccount/azurerm"
  version = "0.2.0"
}
resource "azurerm_resource_group" "rg" { name = "rg" location = "westeurope" }
`;

describe('terraformUnsafe', () => {
  it('accepts registry providers and modules, local modules in the repository, and any backend (TerraVision plans with a local one)', () => {
    expect(terraformUnsafe([file('infra/main.tf', SAFE), file('infra/modules/network/main.tf', 'resource "azurerm_virtual_network" "v" {}')])).toBeUndefined();
  });

  it('refuses code that runs programs during plan or apply', () => {
    expect(terraformUnsafe([file('main.tf', 'data "external" "x" { program = ["sh", "-c", "id"] }')])).toMatch(/external/);
    expect(terraformUnsafe([file('main.tf', 'resource "null_resource" "x" {\n  provisioner "local-exec" { command = "id" }\n}')])).toMatch(/provisioner/);
    expect(terraformUnsafe([file('main.tf', 'resource "aws_instance" "x" {\n  provisioner "remote-exec" { inline = ["id"] }\n}')])).toMatch(/provisioner/);
  });

  it('refuses modules from anywhere but the public registry or a folder of the repository', () => {
    for (const source of ['git::https://example.com/x.git', 'github.com/org/repo', 'https://example.com/m.zip', 's3::https://b/x.zip', '../../../outside', '/abs/path', 'app.terraform.io/org/name/aws', 'hashicorp/consul/aws//modules/x?ref=1']) {
      expect(terraformUnsafe([file('infra/main.tf', `module "m" {\n  source = "${source}"\n}`)]), source).toMatch(/module source/);
    }
  });

  it('refuses a local module folder whose files were not checked', () => {
    expect(terraformUnsafe([file('infra/main.tf', 'module "m" {\n  source = "./vendor/m"\n}')])).toMatch(/wasn't checked/);
  });

  it('refuses providers from other registries', () => {
    expect(terraformUnsafe([file('main.tf', 'terraform {\n  required_providers {\n    x = { source = "evil.example.com/org/x" }\n  }\n}')])).toMatch(/provider source/);
    expect(terraformUnsafe([file('main.tf', 'terraform {\n  required_providers {\n    x = {\n      source = "app.terraform.io/org/x"\n    }\n  }\n}')])).toMatch(/provider source/);
  });

  it("refuses Terraform JSON files, which this check doesn't read", () => {
    expect(terraformUnsafe([file('main.tf.json', '{}')])).toMatch(/JSON/);
  });
});
