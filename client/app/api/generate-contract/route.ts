/* eslint-disable @typescript-eslint/no-unused-vars */
import { NextRequest, NextResponse } from "next/server";
import { CairoContractGenerator } from "@/lib/devxstark/contract-generator1";
import prisma from "@/lib/db";
import { getOrCreateUser } from "@/app/api/transactions/helper";
import { DojoContractGenerator } from "@/lib/devxstark/dojo-contract-generator";

export async function POST(req: NextRequest) {
  const controller = new AbortController();
  const signal = controller.signal;

  // Set a timeout for the request
  const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

  try {
    const { nodes, edges, flowSummary, userId, blockchain } = await req.json();
    // Validate input
    if (
      !Array.isArray(nodes) ||
      !Array.isArray(edges) ||
      !Array.isArray(flowSummary)
    ) {
      return NextResponse.json(
        {
          error:
            "Invalid input format. Expected arrays for nodes and edges, and string for flowSummary.",
          received: {
            nodes: typeof nodes,
            edges: typeof edges,
            flowSummary: typeof flowSummary,
          },
        },
        { status: 400 }
      );
    }

    const flowSummaryJSON = {
      nodes,
      edges,
      summary: flowSummary,
    };

    // Create a more robust body string with proper error handling
    const bodyOfTheCall = Object.entries(flowSummaryJSON)
      .map(([key, value]) => {
        if (Array.isArray(value)) {
          return `${key}: [${value.join(", ")}]`;
        }
        return `${key}: ${value}`;
      })
      .join(", ");

    const generators = {
      blockchain1: new CairoContractGenerator(),
      blockchain4: new DojoContractGenerator(),
    };
    const generator = generators[blockchain as "blockchain1" | "blockchain4"];

    // Create a response object that supports streaming
    const response = new NextResponse(
      new ReadableStream({
        async start(controller) {
          try {
            // Generate the contract with streaming support
            const result = await generator.generateContract(bodyOfTheCall, {
              /* onProgress: (chunk) => {
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify({ type: 'progress', data: chunk }) + '\n'
                  )
                );
              }, */
              //uncomment the above code block to enable progress tracking
              // output only the chunk
              onProgress: (chunk) => {
                controller.enqueue(new TextEncoder().encode(chunk));
              },
            });

            if (!result.sourceCode) {
              throw new Error("Failed to generate source code.");
            }

            // Save the contract source code
            const savedPath = await generator.saveContract(
              result.sourceCode,
              "lib"
            );
            await getOrCreateUser(userId);
            await prisma.generatedContract.create({
              data: {
                name: "Generated Contract",
                sourceCode: result.sourceCode,
                userId,
              },
            });
            // Send final success message
            controller.enqueue(
              new TextEncoder().encode(
                "\n\n" +
                  JSON.stringify({
                    type: "complete",
                    success: true,
                    message: "Contract generated and saved successfully.",
                    path: savedPath,
                  }) +
                  "\n"
              )
            );
          } catch (error) {
            controller.enqueue(
              new TextEncoder().encode(
                JSON.stringify({
                  type: "error",
                  error:
                    error instanceof Error
                      ? error.message
                      : "An unexpected error occurred",
                }) + "\n"
              )
            );
          } finally {
            controller.close();
            clearTimeout(timeoutId);
          }
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      }
    );

    return response;
  } catch (error) {
    clearTimeout(timeoutId);

    console.error("API error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred",
      },
      { status: 500 }
    );
  }
}
