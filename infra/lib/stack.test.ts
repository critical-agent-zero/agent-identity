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
