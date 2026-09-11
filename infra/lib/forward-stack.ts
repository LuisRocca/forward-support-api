// Entorno mínimo de demo: una sola distribución CloudFront sirve el front (/*)
// y la API (/api/*) bajo el mismo dominio, que es lo que necesita la cookie de
// refresh SameSite=Strict. Decisiones y costes en docs/DECISIONES-TECNICAS.md §9.
import { resolve } from 'node:path';

import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

const API_DIR = resolve(import.meta.dirname, '../..');
const FRONT_DIST = resolve(API_DIR, '../erp_forward/dist');

const DB_NAME = 'forward_support';
const API_PORT = 3000;

// DATABASE_URL se compone al arrancar el contenedor: la contraseña solo existe
// en Secrets Manager y llega como variable. Se excluyen de ella los caracteres
// con significado en una URL para no tener que codificarla.
const DB_URL = 'postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME';
const RDS_CA = '/app/certs/rds-global-bundle.pem';
// pg (API y seed) y el motor de migraciones de Prisma verifican el certificado
// de RDS, pero cada uno con su propia sintaxis de parámetros.
const DB_URL_PG = `${DB_URL}?sslmode=verify-full&sslrootcert=${RDS_CA}`;
const DB_URL_PRISMA = `${DB_URL}?sslmode=require&sslaccept=strict&sslcert=${RDS_CA}`;

function conDatabaseUrl(url: string, comando: string): string[] {
  // exec: el proceso de Node sustituye al shell y recibe el SIGTERM de ECS.
  return ['sh', '-c', `export DATABASE_URL="${url}" && exec ${comando}`];
}

export class ForwardStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Sin NAT Gateway (~32 USD/mes): las tareas salen a internet por IP pública
    // y solo aceptan tráfico del ALB. ALB y base viven en subredes aisladas.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // ------------------------------------------------------------ Base de datos
    const db = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_18_3 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      databaseName: DB_NAME,
      credentials: rds.Credentials.fromGeneratedSecret('forward', {
        excludeCharacters: ' !"#$%&\'()*+,/:;<=>?@[\\]^`{|}~',
      }),
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: false,
      publiclyAccessible: false,
      backupRetention: Duration.days(1),
      // cdk destroy deja un snapshot final: borrar la base nunca es un accidente.
      removalPolicy: RemovalPolicy.SNAPSHOT,
    });
    const dbSecret = db.secret;
    if (dbSecret === undefined) throw new Error('RDS no generó el secreto de credenciales');

    const jwtAccessSecret = new secretsmanager.Secret(this, 'JwtAccessSecret', {
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });
    const seedPassword = new secretsmanager.Secret(this, 'SeedPassword', {
      description: 'Contraseña de las cuentas de prueba (admin, supervisor, agente)',
      generateSecretString: { passwordLength: 20, excludePunctuation: true },
    });

    const dbEnv = {
      DB_HOST: db.dbInstanceEndpointAddress,
      DB_PORT: db.dbInstanceEndpointPort,
      DB_NAME,
    };
    const dbSecrets = {
      DB_USER: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
    };

    // ------------------------------------------------------------- Front + CDN
    const frontBucket = new s3.Bucket(this, 'Front', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Rutas del SPA (sin extensión) → index.html. Con las "error responses" de
    // CloudFront también se reescribirían los 404 de la API, que son JSON.
    const spaRewrite = new cloudfront.Function(this, 'SpaRewrite', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event) { var r = event.request; if (r.uri.indexOf('.') === -1) r.uri = '/index.html'; return r; }",
      ),
    });

    // ALB interno: solo CloudFront llega a él (VPC origin), así nadie puede
    // saltarse la CDN ni falsificar X-Forwarded-For.
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });
    alb.connections.allowFrom(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(80));

    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [{ function: spaRewrite, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: origins.VpcOrigin.withApplicationLoadBalancer(alb, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        },
      },
    });

    new s3deploy.BucketDeployment(this, 'FrontDeploy', {
      sources: [s3deploy.Source.asset(FRONT_DIST)],
      destinationBucket: frontBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // --------------------------------------------------------------------- API
    const cluster = new ecs.Cluster(this, 'Cluster', { vpc });
    const taskSg = new ec2.SecurityGroup(this, 'TaskSg', { vpc, description: 'Tareas de la API' });
    db.connections.allowDefaultPortFrom(taskSg);

    const apiImage = ecs.ContainerImage.fromAsset(API_DIR, { target: 'runtime', platform: Platform.LINUX_AMD64 });
    const migrateImage = ecs.ContainerImage.fromAsset(API_DIR, { target: 'migrate', platform: Platform.LINUX_AMD64 });

    const logGroup = (id: string): ecs.LogDriver =>
      ecs.LogDrivers.awsLogs({
        streamPrefix: id,
        logGroup: new logs.LogGroup(this, `${id}Logs`, {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      });

    const taskDefinition = (id: string, cpu: number, memoryLimitMiB: number): ecs.FargateTaskDefinition =>
      new ecs.FargateTaskDefinition(this, id, {
        cpu,
        memoryLimitMiB,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.X86_64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      });

    const apiTask = taskDefinition('ApiTask', 256, 512);
    apiTask.addContainer('api', {
      image: apiImage,
      command: conDatabaseUrl(DB_URL_PG, 'node dist/main.js'),
      portMappings: [{ containerPort: API_PORT }],
      logging: logGroup('Api'),
      environment: {
        ...dbEnv,
        NODE_ENV: 'production',
        PORT: String(API_PORT),
        API_PREFIX: 'api',
        // CloudFront + ALB: con 1, req.ip sería la IP de CloudFront.
        TRUST_PROXY_HOPS: '2',
        DOCS_ENABLED: 'false',
        CORS_ORIGIN: `https://${distribution.distributionDomainName}`,
      },
      secrets: {
        ...dbSecrets,
        JWT_ACCESS_SECRET: ecs.Secret.fromSecretsManager(jwtAccessSecret),
      },
    });

    const service = new ecs.FargateService(this, 'ApiService', {
      cluster,
      taskDefinition: apiTask,
      desiredCount: 1,
      minHealthyPercent: 100,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [taskSg],
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: Duration.seconds(60),
    });

    alb.addListener('Http', { port: 80, open: false }).addTargets('Api', {
      port: API_PORT,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service],
      deregistrationDelay: Duration.seconds(10),
      healthCheck: { path: '/api/health', interval: Duration.seconds(15), healthyThresholdCount: 2 },
    });

    // ------------------------------------------ Tareas puntuales (run-task.sh)
    const migrateTask = taskDefinition('MigrateTask', 256, 512);
    migrateTask.addContainer('migrate', {
      image: migrateImage,
      command: conDatabaseUrl(DB_URL_PRISMA, 'node_modules/.bin/prisma migrate deploy'),
      logging: logGroup('Migrate'),
      environment: dbEnv,
      secrets: dbSecrets,
    });

    const seedTask = taskDefinition('SeedTask', 512, 1024);
    seedTask.addContainer('seed', {
      image: migrateImage,
      command: conDatabaseUrl(DB_URL_PG, 'node_modules/.bin/prisma db seed'),
      logging: logGroup('Seed'),
      environment: dbEnv,
      secrets: { ...dbSecrets, SEED_PASSWORD: ecs.Secret.fromSecretsManager(seedPassword) },
    });

    new CfnOutput(this, 'Url', { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'MigrateTaskArn', { value: migrateTask.taskDefinitionArn });
    new CfnOutput(this, 'SeedTaskArn', { value: seedTask.taskDefinitionArn });
    new CfnOutput(this, 'TaskSubnets', { value: vpc.publicSubnets.map((s) => s.subnetId).join(',') });
    new CfnOutput(this, 'TaskSecurityGroup', { value: taskSg.securityGroupId });
    new CfnOutput(this, 'SeedPasswordSecret', { value: seedPassword.secretName });
  }
}
