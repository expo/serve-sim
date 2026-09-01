import { useEffect, useState } from "react";

const QUERY = "(pointer: coarse)";

/** True on touch input, where hover and fine-pointer assumptions don't apply. */
export function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(
    () => typeof window !== "undefined" && window.matchMedia?.(QUERY).matches === true,
  );
  useEffect(() => {
    const mql = window.matchMedia?.(QUERY);
    if (!mql) return;
    const onChange = () => setCoarse(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return coarse;
}
