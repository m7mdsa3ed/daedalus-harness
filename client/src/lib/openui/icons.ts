/* The one fixed glyph set a generated view may name: a Flowchart node's mark. Kept apart from kit.tsx so the read-only graphs that import
   the flowchart outside the OpenUI chunk do not pull the kit in with it. */
import {
  Activity, ArrowDown, ArrowUp, Ban, Box, Bug, Check, Clock, Cloud, Code, Database, DollarSign, FlaskConical, Globe, Info, Lock,
  MinusCircle, Server, Shield, Star, TriangleAlert, Users, X, Zap, type LucideIcon,
} from "lucide-react"

/** The base glyphs, in the order the prompt lists them. */
export const ICONS: Record<string, LucideIcon> = {
  activity: Activity, "arrow-down": ArrowDown, "arrow-up": ArrowUp, bug: Bug, check: Check, clock: Clock, cloud: Cloud, code: Code,
  database: Database, dollar: DollarSign, globe: Globe, info: Info, lock: Lock, server: Server, shield: Shield, star: Star,
  alert: TriangleAlert, users: Users, x: X, zap: Zap,
}

/** A decision chart's few extra marks: the subject of a question and its outcomes. */
export const FLOW_ICONS: Record<string, LucideIcon> = {
  ...ICONS, box: Box, flask: FlaskConical, ban: Ban, minus: MinusCircle,
}

export const iconNames = (set: Record<string, LucideIcon>) => Object.keys(set) as [string, ...string[]]
