# team

```
USAGE
  linear team <subcommand> [flags]

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level

SUBCOMMANDS
  list         
  create       
  delete       
  id           
  autolinks    
  members
```

## Subcommands

### list

```
USAGE
  linear team list [flags]

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### create

```
USAGE
  linear team create [flags]

FLAGS
  --name string           
  --key string            
  --description string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### delete

```
USAGE
  linear team delete [flags] <team-id>

ARGUMENTS
  team-id string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### id

```
USAGE
  linear team id [flags] [<key>]

ARGUMENTS
  key string     (optional)

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### autolinks

```
USAGE
  linear team autolinks [flags] [<team>]

ARGUMENTS
  team string     (optional)

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### members

```
USAGE
  linear team members [flags] [<team>]

ARGUMENTS
  team string     (optional)

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```
