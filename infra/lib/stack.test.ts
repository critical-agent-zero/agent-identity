import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, it } from "vitest";
import { AgentIdentityStack, type AgentIdentityStackProps } from "./stack.js";

// Skip Lambda asset bundling — these tests assert on synthesized resources,
// not function code, and bundling would shell out to esbuild per function.
const synth = (props: Partial<AgentIdentityStackProps> = {}, context: Record<string, unknown> = {}) => {
  const app = new App({ context: { "aws:cdk:bundling-stacks": [], ...context } });
  const stack = new AgentIdentityStack(app, "Test", { domain: "mail.example.com", ...props });
  return Template.fromStack(stack);
};

describe("cors", () => {
  it("allows browser dashboards to call the API (GET + the read-key headers)", () => {
    synth().hasResourceProperties("AWS::ApiGatewayV2::Api", {
      CorsConfiguration: {
        AllowOrigins: ["*"],
        AllowMethods: ["GET"],
        AllowHeaders: ["content-type", "x-viewer-key"],
      },
    });
  });
});

describe("api throttling", () => {
  it("throttles the default stage by default", () => {
    synth().hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      DefaultRouteSettings: { ThrottlingRateLimit: 25, ThrottlingBurstLimit: 50 },
    });
  });

  it("honors apiThrottle overrides", () => {
    synth({ apiThrottle: { rateLimit: 5, burstLimit: 10 } }).hasResourceProperties(
      "AWS::ApiGatewayV2::Stage",
      { DefaultRouteSettings: { ThrottlingRateLimit: 5, ThrottlingBurstLimit: 10 } },
    );
  });
});

describe("public fleet repo allowlist", () => {
  it("defaults PUBLIC_REPOS to the empty string — the public tier fails closed", () => {
    synth().hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({ PUBLIC_REPOS: "", TABLE_NAME: Match.anyValue() }),
      },
    });
  });

  it("honors the publicRepos context", () => {
    synth({}, { publicRepos: "critical-labs/*,acme/widgets" }).hasResourceProperties(
      "AWS::Lambda::Function",
      {
        Environment: {
          Variables: Match.objectLike({ PUBLIC_REPOS: "critical-labs/*,acme/widgets" }),
        },
      },
    );
  });
});

describe("auto-capabilities policy", () => {
  it("defaults AUTO_CAPABILITIES to the empty string — the feature is off", () => {
    synth().hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({ AUTO_CAPABILITIES: "", PUBLIC_REPOS: Match.anyValue() }),
      },
    });
  });

  it("honors the autoCapabilities context", () => {
    synth({}, { autoCapabilities: "github,email" }).hasResourceProperties(
      "AWS::Lambda::Function",
      {
        Environment: {
          Variables: Match.objectLike({ AUTO_CAPABILITIES: "github,email" }),
        },
      },
    );
  });
});

describe("ingest sender allowlist", () => {
  it("defaults MAIL_SENDER_ALLOWLIST to the forge domains", () => {
    synth().hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({ MAIL_SENDER_ALLOWLIST: "github.com,gitlab.com" }),
      },
    });
  });

  it("honors the senderAllowlist context", () => {
    synth({}, { senderAllowlist: "example.org,forge.example" }).hasResourceProperties(
      "AWS::Lambda::Function",
      {
        Environment: {
          Variables: Match.objectLike({ MAIL_SENDER_ALLOWLIST: "example.org,forge.example" }),
        },
      },
    );
  });
});

describe("mailbox domain catch-all (issue #114)", () => {
  // A named mailbox's optional --catch-all routes unknown local-parts into it.
  // No SES receipt-rule change is needed for this: the rule's recipient is
  // already the bare domain, which SES treats as a catch-all matching EVERY
  // local-part at that domain. The Lambda already receives mail for unknown
  // local-parts (they are simply dropped today); catch-all is a pure
  // ingest/table concern. This test pins that the recipient stays the domain.
  it("receives all local-parts at the domain (bare-domain recipient = SES catch-all)", () => {
    synth().hasResourceProperties("AWS::SES::ReceiptRule", {
      Rule: Match.objectLike({ Recipients: ["mail.example.com"] }),
    });
  });
});

describe("cost budget", () => {
  it("creates a $25 monthly budget with 80% actual and 100% forecast email alerts when budgetEmail is set", () => {
    const t = synth({}, { budgetEmail: "ops@example.com" });
    t.hasResourceProperties("AWS::Budgets::Budget", {
      Budget: {
        BudgetType: "COST",
        TimeUnit: "MONTHLY",
        BudgetLimit: { Amount: 25, Unit: "USD" },
      },
      NotificationsWithSubscribers: [
        {
          Notification: { NotificationType: "ACTUAL", Threshold: 80 },
          Subscribers: [{ SubscriptionType: "EMAIL", Address: "ops@example.com" }],
        },
        {
          Notification: { NotificationType: "FORECASTED", Threshold: 100 },
          Subscribers: [{ SubscriptionType: "EMAIL", Address: "ops@example.com" }],
        },
      ],
    });
  });

  it("creates no budget when no email is configured", () => {
    synth().resourceCountIs("AWS::Budgets::Budget", 0);
  });

  it("honors a budgetUsd override", () => {
    synth({}, { budgetEmail: "ops@example.com", budgetUsd: "40" })
      .hasResourceProperties("AWS::Budgets::Budget", {
        Budget: { BudgetLimit: { Amount: 40, Unit: "USD" } },
      });
  });
});
