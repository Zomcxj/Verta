//! A colour as a deck states it, and what its modifiers do to it.
//!
//! A colour in a presentation is either written out (`<a:srgbClr val="4472C4"/>`) or named as a
//! theme role (`<a:schemeClr val="accent1"/>`), and a named one may carry modifiers that darken,
//! lighten or mix it. Neither the theme nor the XML reader lives here: this module is the arithmetic
//! between a colour the theme answers with and the colour a modifier makes of it.

use std::collections::HashMap;

/// What a theme answers: the colour slots a `<a:clrScheme>` names, and the roles a `<p:clrMap>`
/// maps onto them.
#[derive(Debug, Default, Clone)]
pub(crate) struct Theme {
    /// A slot (`dk1`, `accent1`) as `#rrggbb`.
    slots: HashMap<String, String>,
    /// A role (`tx1`, `bg1`) as the slot it stands for.
    roles: HashMap<String, String>,
    /// A font slot (`+mj-lt`, `+mn-lt`) as a typeface.
    fonts: HashMap<String, String>,
}

impl Theme {
    /// A theme built from what was read.
    pub(crate) fn from_parts(
        slots: impl IntoIterator<Item = (String, String)>,
        roles: impl IntoIterator<Item = (String, String)>,
        fonts: impl IntoIterator<Item = (String, String)>,
    ) -> Self {
        Theme {
            slots: slots.into_iter().collect(),
            roles: roles.into_iter().collect(),
            fonts: fonts.into_iter().collect(),
        }
    }

    /// The colour a role stands for.
    ///
    /// A role is not a slot: `tx1` is what a master's `clrMap` says the text colour is, and the
    /// answer is usually `dk1`. A slot named directly is also accepted, because a `schemeClr` may
    /// name either one.
    pub(crate) fn slot(&self, role: &str) -> Option<&String> {
        let slot = self.roles.get(role).map(String::as_str).unwrap_or(role);
        self.slots.get(slot)
    }

    /// The typeface a font slot stands for.
    pub(crate) fn font(&self, slot: &str) -> Option<&String> {
        self.fonts.get(slot)
    }

    /// This theme with the roles a master's `clrMap` names.
    pub(crate) fn with_roles(mut self, roles: HashMap<String, String>) -> Self {
        self.roles.extend(roles);
        self
    }
}

/// A colour as the file states it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ColorRef {
    /// Written out.
    Srgb(String),
    /// Named as a theme role, with the modifiers it carries in order.
    Scheme {
        role: String,
        modifiers: Vec<(String, f64)>,
    },
}

impl ColorRef {
    /// The `#rrggbb` this colour is, or nothing when the theme does not name it.
    pub(crate) fn resolve(&self, theme: &Theme) -> Option<String> {
        match self {
            ColorRef::Srgb(color) => Some(color.clone()),
            ColorRef::Scheme { role, modifiers } => {
                let base = theme.slot(role)?;
                Some(apply_modifiers(base, modifiers))
            }
        }
    }
}

/// A colour with its modifiers applied.
///
/// The modifiers are lightness operations, so they are applied in HSL: `lumMod` scales the
/// lightness, `lumOff` adds to it, `tint` mixes towards white and `shade` towards black. `alpha` is
/// transparency, which the pane does not draw, and `satMod` is rare enough to stay out; both are
/// ignored rather than guessed at.
pub(crate) fn apply_modifiers(base: &str, modifiers: &[(String, f64)]) -> String {
    let Some((hue, saturation, mut lightness)) = rgb_to_hsl(base) else {
        return base.to_string();
    };
    for (name, value) in modifiers {
        let fraction = *value / 100.0;
        match name.as_str() {
            "lumMod" => lightness *= fraction,
            "lumOff" => lightness += fraction,
            "tint" => lightness += (1.0 - lightness) * fraction,
            "shade" => lightness *= fraction,
            _ => {}
        }
    }
    hsl_to_rgb(hue, saturation, lightness.clamp(0.0, 1.0))
}

/// `#rrggbb` as hue, saturation and lightness, each 0 to 1.
fn rgb_to_hsl(color: &str) -> Option<(f64, f64, f64)> {
    let (red, green, blue) = channels(color)?;
    let red = red / 255.0;
    let green = green / 255.0;
    let blue = blue / 255.0;
    let max = red.max(green).max(blue);
    let min = red.min(green).min(blue);
    let lightness = (max + min) / 2.0;
    if (max - min).abs() < f64::EPSILON {
        return Some((0.0, 0.0, lightness));
    }
    let delta = max - min;
    let saturation = if lightness > 0.5 {
        delta / (2.0 - max - min)
    } else {
        delta / (max + min)
    };
    let hue = if max == red {
        ((green - blue) / delta + if green < blue { 6.0 } else { 0.0 }) / 6.0
    } else if max == green {
        ((blue - red) / delta + 2.0) / 6.0
    } else {
        ((red - green) / delta + 4.0) / 6.0
    };
    Some((hue, saturation, lightness))
}

/// The three channels of a `#rrggbb`, each 0 to 255.
fn channels(color: &str) -> Option<(f64, f64, f64)> {
    let hex = color.trim_start_matches('#');
    if hex.len() != 6 {
        return None;
    }
    let red = u8::from_str_radix(&hex[0..2], 16).ok()? as f64;
    let green = u8::from_str_radix(&hex[2..4], 16).ok()? as f64;
    let blue = u8::from_str_radix(&hex[4..6], 16).ok()? as f64;
    Some((red, green, blue))
}

/// Hue, saturation and lightness back as `#rrggbb`.
fn hsl_to_rgb(hue: f64, saturation: f64, lightness: f64) -> String {
    if saturation <= 0.0 {
        let grey = (lightness * 255.0).round() as u8;
        return format!("#{grey:02x}{grey:02x}{grey:02x}");
    }
    let second = if lightness < 0.5 {
        lightness * (1.0 + saturation)
    } else {
        lightness + saturation - lightness * saturation
    };
    let first = 2.0 * lightness - second;
    let channel = |offset: f64| {
        let mut value = offset;
        if value > 1.0 {
            value -= 1.0;
        }
        let value = if 6.0 * value < 1.0 {
            first + (second - first) * 6.0 * value
        } else if 2.0 * value < 1.0 {
            second
        } else if 3.0 * value < 2.0 {
            first + (second - first) * (2.0 / 3.0 - value) * 6.0
        } else {
            first
        };
        (value.clamp(0.0, 1.0) * 255.0).round() as u8
    };
    format!(
        "#{:02x}{:02x}{:02x}",
        channel(hue + 1.0 / 3.0),
        channel(hue),
        channel(hue - 1.0 / 3.0)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_literal_colour_resolves_to_itself() {
        let reference = ColorRef::Srgb("#3366cc".to_string());
        assert_eq!(
            reference.resolve(&Theme::default()),
            Some("#3366cc".to_string())
        );
    }

    #[test]
    fn a_role_is_the_slot_the_map_points_at() {
        // `tx1` is a role, not a slot: without the map it would be looked up as a slot name and
        // not found, which is how a dark deck's body text came out black instead of white.
        let theme = Theme::from_parts(
            [("dk1".to_string(), "#000000".to_string())],
            [("tx1".to_string(), "dk1".to_string())],
            [],
        );
        let reference = ColorRef::Scheme {
            role: "tx1".to_string(),
            modifiers: Vec::new(),
        };
        assert_eq!(reference.resolve(&theme), Some("#000000".to_string()));
    }

    #[test]
    fn a_colour_the_theme_does_not_name_resolves_to_nothing() {
        let reference = ColorRef::Scheme {
            role: "accent7".to_string(),
            modifiers: Vec::new(),
        };
        assert_eq!(reference.resolve(&Theme::default()), None);
    }

    #[test]
    fn lum_mod_darkens_and_lum_off_lifts() {
        // `lumMod 20000` is a fifth of the lightness, which is how a master writes a darker
        // shade of an accent.
        assert_eq!(
            apply_modifiers("#4472c4", &[("lumMod".to_string(), 20.0)]),
            "#0d1728"
        );
        // `lumOff` lifts a black to a grey.
        assert_eq!(
            apply_modifiers("#000000", &[("lumOff".to_string(), 50.0)]),
            "#808080"
        );
    }

    #[test]
    fn tint_mixes_towards_white_and_shade_towards_black() {
        assert_eq!(
            apply_modifiers("#000000", &[("tint".to_string(), 50.0)]),
            "#808080"
        );
        assert_eq!(
            apply_modifiers("#ffffff", &[("shade".to_string(), 50.0)]),
            "#808080"
        );
    }

    #[test]
    fn a_modifier_that_is_not_applied_leaves_the_colour_alone() {
        // `alpha` is transparency, which the pane does not draw, and `satMod` is rare enough to
        // stay out; neither may shift a colour.
        assert_eq!(
            apply_modifiers(
                "#4472c4",
                &[("alpha".to_string(), 50.0), ("satMod".to_string(), 50.0)]
            ),
            "#4472c4"
        );
    }
}
