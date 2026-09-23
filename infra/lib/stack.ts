import {
  CfnOutput, Duration, RemovalPolicy, Stack, type StackProps,
} from "aws-cdk-lib";
import { CfnStage, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { ReceiptRuleSet } from "aws-cdk-lib/aws-ses";
import * as actions from "aws-cdk-lib/aws-ses-actions";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";

const pkg = (p: string) => fileURLToPath(new URL(`../../packages/${p}`, import.meta.url));

export interface AgentIdentityStackProps extends StackProps {
  domain: string;
  retentionDays?: number;
  /** Default-stage throttling. Every request costs a Lambda invoke plus a
   *  DynamoDB nonce write, so an unthrottled endpoint is a denial-of-wallet
   *  surface for whoever self-hosts this stack — protection is on by default
   *  and only tunable, not removable, from props. */
  apiThrottle?: { rateLimit: number; burstLimit: number };
}

export class AgentIdentityStack extends Stack {
  constructor(scope: Construct, id: string, props: AgentIdentityStackProps) {
    super(scope, id, props);
    const retentionDays = props.retentionDays ?? 90;

    const table = new Table(this, "Table", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const bucket = new Bucket(this, "Mail", {
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        { prefix: "raw/", expiration: Duration.days(retentionDays) },
        { prefix: "bodies/", expiration: Duration.days(retentionDays) },
        { prefix: "unmatched/", expiration: Duration.days(7) },
      ],
    });

    const commonEnv = {
      TABLE_NAME: table.tableName,
      BUCKET_NAME: bucket.bucketName,
      MAIL_DOMAIN: props.domain,
      RETENTION_DAYS: String(retentionDays),
    };
    const fnDefaults = {
      runtime: Runtime.NODEJS_20_X,
      bundling: {
        format: OutputFormat.ESM,
        // mailparser (CJS) calls require("stream") at module scope; esbuild's
        // ESM output stubs require() with a throw unless we provide a real one.
        banner: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      environment: commonEnv,
    };

    const ingestFn = new NodejsFunction(this, "Ingest", {
      ...fnDefaults,
      entry: pkg("ingest/src/handler.ts"),
      timeout: Duration.seconds(30),
      environment: {
        ...commonEnv,
        // Sender domains delivered unflagged; everything else is stored with
        // unsolicited: true. Comma-separated, subdomains match implicitly.
        MAIL_SENDER_ALLOWLIST:
          this.node.tryGetContext("senderAllowlist") ?? "github.com,gitlab.com",
      },
    });
    table.grantReadWriteData(ingestFn);
    bucket.grantReadWrite(ingestFn);

    const apiFn = new NodejsFunction(this, "Api", {
      ...fnDefaults,
      entry: pkg("api/src/lambda.ts"),
      environment: {
        ...commonEnv,
        // Repos the UNAUTHENTICATED public fleet tier may mention:
        // comma-separated "owner/repo" or "owner/*" patterns, matched
        // case-insensitively on exact segments. Defaults to EMPTY — an empty
        // allowlist means the public tier shows no forge events at all.
        PUBLIC_REPOS: this.node.tryGetContext("publicRepos") ?? "",
      },
    });
    table.grantReadWriteData(apiFn);
    bucket.grantRead(apiFn);

    const httpApi = new HttpApi(this, "HttpApi", {
      defaultIntegration: new HttpLambdaIntegration("ApiInt", apiFn),
    });
    // The L2 HttpApi's auto-created $default stage exposes no throttle prop;
    // set it on the L1. Applies to every route, /forge/* included.
    const throttle = props.apiThrottle ?? { rateLimit: 25, burstLimit: 50 };
    (httpApi.defaultStage!.node.defaultChild as CfnStage).defaultRouteSettings = {
      throttlingRateLimit: throttle.rateLimit,
      throttlingBurstLimit: throttle.burstLimit,
    };

    const proxyFn = new NodejsFunction(this, "Proxy", {
      ...fnDefaults,
      entry: pkg("proxy/src/lambda.ts"),
      // Forge operations make several sequential upstream calls (e.g. provision:
      // list/create service account, add member, mint PAT, store in SSM), well
      // beyond the 3s Lambda default. Cap under the API Gateway 30s limit.
      timeout: Duration.seconds(29),
      environment: {
        ...commonEnv,
        FORGE_GITHUB_FORK_OWNER: this.node.tryGetContext("githubForkOwner") ?? "",
      },
    });
    table.grantReadWriteData(proxyFn);
    proxyFn.addToRolePolicy(new PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/agent-identity/forge/*`],
    }));
    proxyFn.addToRolePolicy(new PolicyStatement({
      actions: ["ssm:PutParameter"],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/agent-identity/forge/gitlab/pat/*`,
      ],
    }));
    httpApi.addRoutes({
      path: "/forge/{proxy+}",
      methods: [HttpMethod.ANY],
      integration: new HttpLambdaIntegration("ProxyInt", proxyFn),
    });

    const rules = new ReceiptRuleSet(this, "Rules", {
      rules: [{
        recipients: [props.domain],
        scanEnabled: true,
        actions: [
          new actions.S3({ bucket, objectKeyPrefix: "raw/" }),
          new actions.Lambda({ function: ingestFn }),
        ],
      }],
    });

    new CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new CfnOutput(this, "ReceiptRuleSetName", { value: rules.receiptRuleSetName });
    new CfnOutput(this, "TableName", { value: table.tableName });
    new CfnOutput(this, "MxRecord", {
      value: `${props.domain} MX 10 inbound-smtp.${this.region}.amazonaws.com`,
    });
  }
}
