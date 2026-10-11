import { useColorScheme } from "react-native";

import { dark, light, type Palette } from "./tokens";

export { fonts, radius, space, type Palette } from "./tokens";

/** The palette for the phone's light or dark setting; dark when it has none. */
export function useColors(): Palette {
  return useColorScheme() === "light" ? light : dark;
}
