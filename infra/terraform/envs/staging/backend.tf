terraform {
  backend "s3" {
    bucket         = "travel-platform-tfstate-staging"
    key            = "staging/terraform.tfstate"
    region         = "eu-west-1"
    encrypt        = true
    kms_key_id     = "alias/staging/platform/secretsmanager"
    dynamodb_table = "travel-platform-tfstate-lock-staging"
  }

  required_version = "~> 1.15"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "eu-west-1"

  default_tags {
    tags = {
      Service            = var.tags.Service
      Environment        = var.tags.Environment
      CostCentre         = var.tags.CostCentre
      Owner              = var.tags.Owner
      DataClassification = var.tags.DataClassification
    }
  }
}
