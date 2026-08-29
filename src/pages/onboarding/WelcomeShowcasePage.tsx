/**
 * WelcomeShowcasePage — first-open onboarding showcase (all devices).
 */
import { useNavigate } from "react-router-dom";
import FeatureShowcase from "@/components/onboarding/FeatureShowcase";

export default function WelcomeShowcasePage() {
  const navigate = useNavigate();

  return (
    <FeatureShowcase
      onFinish={() => {
        try {
          localStorage.setItem("megsy_seen_welcome", "1");
        } catch {}
        navigate("/auth", { replace: true });
      }}
    />
  );
}
