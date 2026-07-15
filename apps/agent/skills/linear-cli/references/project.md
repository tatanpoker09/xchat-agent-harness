# project

```
USAGE
  linear project <subcommand> [flags]

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level

SUBCOMMANDS
  list      
  view      
  create    
  update    
  delete
```

## Subcommands

### list

```
USAGE
  linear project list [flags]

FLAGS
  --team string      
  --limit integer    
  --json             

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### view

```
USAGE
  linear project view [flags] <id-or-slug>

ARGUMENTS
  id-or-slug string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### create

```
USAGE
  linear project create [flags]

FLAGS
  --name string           
  --description string    
  --team string           
  --lead string           
  --state string          
  --target-date string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### update

```
USAGE
  linear project update [flags] <id>

ARGUMENTS
  id string    

FLAGS
  --name string           
  --description string    
  --state string          
  --lead string           
  --target-date string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### delete

```
USAGE
  linear project delete [flags] <id>

ARGUMENTS
  id string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```
