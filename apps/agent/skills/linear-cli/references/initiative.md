# initiative

```
USAGE
  linear initiative <subcommand> [flags]

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
  archive           
  unarchive         
  add-project       
  remove-project
```

## Subcommands

### list

```
USAGE
  linear initiative list [flags]

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### view

```
USAGE
  linear initiative view [flags] <id>

ARGUMENTS
  id string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### create

```
USAGE
  linear initiative create [flags]

FLAGS
  --name string           
  --description string    
  --owner string          

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### update

```
USAGE
  linear initiative update [flags] <id>

ARGUMENTS
  id string    

FLAGS
  --name string           
  --description string    
  --owner string          

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### delete

```
USAGE
  linear initiative delete [flags] <id>

ARGUMENTS
  id string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### archive

```
USAGE
  linear initiative archive [flags] <id>

ARGUMENTS
  id string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### unarchive

```
USAGE
  linear initiative unarchive [flags] <id>

ARGUMENTS
  id string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### add-project

```
USAGE
  linear initiative add-project [flags] <initiative-id> <project-id>

ARGUMENTS
  initiative-id string    
  project-id string       

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### remove-project

```
USAGE
  linear initiative remove-project [flags] <initiative-id> <project-id>

ARGUMENTS
  initiative-id string    
  project-id string       

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```
