# Public subnets — internet-facing ALB tier, one per AZ
resource "aws_subnet" "public" {
  count                   = length(var.availability_zones)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = "${data.aws_region.current.name}${var.availability_zones[count.index]}"
  map_public_ip_on_launch = true

  tags = {
    Name        = "${var.environment}-public-${var.availability_zones[count.index]}"
    Environment = var.environment
    Tier        = "public"
  }
}

# Private application subnets — ECS task tier, one per AZ
resource "aws_subnet" "private_app" {
  count             = length(var.availability_zones)
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_app_subnet_cidrs[count.index]
  availability_zone = "${data.aws_region.current.name}${var.availability_zones[count.index]}"

  tags = {
    Name        = "${var.environment}-private-app-${var.availability_zones[count.index]}"
    Environment = var.environment
    Tier        = "private-app"
  }
}

# Private data subnets — RDS and ElastiCache tier, one per AZ.
# Non-production environments receive DataClassification=Synthetic (BR-18): these
# subnets carry only synthetic data and must never receive a production restore.
resource "aws_subnet" "private_data" {
  count             = length(var.availability_zones)
  vpc_id            = aws_vpc.main.id
  cidr_block        = var.private_data_subnet_cidrs[count.index]
  availability_zone = "${data.aws_region.current.name}${var.availability_zones[count.index]}"

  tags = merge(
    {
      Name        = "${var.environment}-private-data-${var.availability_zones[count.index]}"
      Environment = var.environment
      Tier        = "private-data"
    },
    var.environment != "production" ? { DataClassification = "Synthetic" } : {}
  )
}

# Public route table — routes all internet traffic through the IGW
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name        = "${var.environment}-public-rt"
    Environment = var.environment
    Tier        = "public"
  }
}

resource "aws_route_table_association" "public" {
  count          = length(var.availability_zones)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}
