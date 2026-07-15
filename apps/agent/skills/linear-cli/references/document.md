# document

```
USAGE
  linear document <subcommand> [flags]

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
  linear document list [flags]

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### view

```
USAGE
  linear document view [flags] <id>

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
  linear document create [flags]

FLAGS
  --title string         
  --content string       
  --project string       
  --team string          
  --initiative string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### update

```
USAGE
  linear document update [flags] <id>

ARGUMENTS
  id string    

FLAGS
  --title string      
  --content string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### delete

```
USAGE
  linear document delete [flags] <id>

ARGUMENTS
  id string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```
