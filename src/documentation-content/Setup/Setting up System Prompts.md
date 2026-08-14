# Setting Up System Prompts

System prompts guide Phantom's behavior and ensure consistency with your organization's development standards.

## What Are System Prompts

Instructions that inform Phantom about:
- Coding standards and security requirements
- Project-specific architecture and conventions
- Code review expectations and PR formats
- Testing and documentation requirements

Benefits: Uniform code style, enforced best practices, reduced review cycles, faster onboarding.

## Creating System Prompts

1. Navigate to Settings > System Prompts
2. Click "Create System Prompt"
3. Enter name (e.g., "React Component Guidelines")
4. Add description
5. Write content in Markdown
6. Set permissions (Private/Team/Organization)
7. Save

### Writing Effective Content

Use clear, structured Markdown:

```markdown
# Coding Standards

## Naming Conventions
- Classes: PascalCase
- Functions: camelCase
- Constants: UPPER_SNAKE_CASE

## Code Quality
- Maximum function length: 50 lines
- Use TypeScript strict mode
- All functions must have type annotations
```

Provide examples:

```markdown
## Component Structure

Correct:
```typescript
export interface ButtonProps {
  label: string;
  onClick: () => void;
}

export const Button: React.FC<ButtonProps> = ({ label, onClick }) => {
  return <button onClick={onClick}>{label}</button>;
};
```
```

## Common Prompt Types

**Coding Standards:**
```markdown
# TypeScript Standards
- Enable strict mode, no implicit any
- Explicit return types for exported functions
- Interfaces: IUserData, Types: UserRole
```

**Security:**
```markdown
# Security Requirements
- Use JWT with refresh tokens
- Validate all inputs, use parameterized queries
- Encrypt sensitive data
```

**Testing:**
```markdown
# Testing Requirements
- Minimum 80% coverage
- Test all edge cases
- Format: describe_whatItDoes_expectedBehavior
```

**Pull Requests:**
```markdown
# PR Guidelines
## Title: [TYPE]: Brief description
Types: FEAT, FIX, DOCS, REFACTOR

## Required: What changed, Why, How, Testing
```

## Using in Workspaces

When creating workspace:
1. Select one or multiple prompts
2. Prompts merged and applied
3. Converted to AGENTS.md and CLAUDE.md in repository root

Multiple prompts combine without conflicts (additive).

### Manual Editing

After workspace creation, edit CLAUDE.md in task environment:
1. Open repository root
2. Open CLAUDE.md
3. Make changes
4. Save (applies only to current task)

## Managing Prompts

**Viewing:** Filter by category, search by name/tag, sort by date
**Editing:** Select prompt > Edit > Modify > Save
**Deleting:** Select > Delete > Confirm (workspaces using it still function)

## Best Practices

**Content:**
- Use simple, clear language
- Provide specific examples
- Be comprehensive but concise
- Verify technical correctness

**Organization:**
- Descriptive names with context
- Assign appropriate categories
- Use consistent tagging

**Permissions:**
- Grant minimum necessary access
- Review periodically
- Document access decisions
