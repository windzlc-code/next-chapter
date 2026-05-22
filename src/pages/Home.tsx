import { Suspense, lazy } from "react";
import { useSearchParams } from "react-router-dom";
import HomeStudioStartupFallback from "@/components/home-agent/HomeStudioStartupFallback";

const HomeAgentStudio = lazy(() => import("@/components/home-agent/HomeAgentStudioBootstrap"));

export default function Home() {
  const [searchParams, setSearchParams] = useSearchParams();
  const utility = searchParams.get("utility") === "settings" ? "settings" : undefined;

  const handleUtilityChange = (next?: "settings") => {
    const updated = new URLSearchParams(searchParams);
    if (next) {
      updated.set("utility", next);
    } else {
      updated.delete("utility");
    }
    setSearchParams(updated, { replace: true });
  };

  return (
    <Suspense fallback={<HomeStudioStartupFallback />}>
      <HomeAgentStudio initialUtility={utility} onUtilityChange={handleUtilityChange} />
    </Suspense>
  );
}
