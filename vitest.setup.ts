import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  // Without Vitest's globals Testing Library cannot register its own cleanup: a component
  // left mounted would keep its subscription into the next test.
  cleanup();
  vi.useRealTimers();
});
