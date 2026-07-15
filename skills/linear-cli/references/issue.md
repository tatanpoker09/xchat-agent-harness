# issue

```
USAGE
  linear issue <subcommand> [flags]

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
  start           
  id              
  title           
  url             
  describe        
  commits         
  pull-request    
  comment         
  attach          
  link            
  relation
```

## Subcommands

### list

```
USAGE
  linear issue list [flags]

FLAGS
  --team string        
  --state string       
  --label string       
  --assignee string    
  --project string     
  --cycle string       
  --all                
  --json               
  --limit integer      
  --after string       

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### view

```
USAGE
  linear issue view [flags] <identifier>

ARGUMENTS
  identifier string    

FLAGS
  --json    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### create

```
USAGE
  linear issue create [flags]

FLAGS
  --title string          
  --team string           
  --description string    
  --assignee string       
  --state string          
  --label string          
  --project string        
  --cycle string          
  --priority integer      
  --estimate integer      
  --due-date string       
  --start                 

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### update

```
USAGE
  linear issue update [flags] <identifier>

ARGUMENTS
  identifier string    

FLAGS
  --title string          
  --description string    
  --state string          
  --assignee string       
  --label string          
  --project string        
  --cycle string          
  --priority integer      
  --estimate integer      
  --due-date string       

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### delete

```
USAGE
  linear issue delete [flags] <identifier>

ARGUMENTS
  identifier string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### start

```
USAGE
  linear issue start [flags] <identifier>

ARGUMENTS
  identifier string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### id

```
USAGE
  linear issue id [flags]

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### title

```
USAGE
  linear issue title [flags] [<identifier>]

ARGUMENTS
  identifier string     (optional)

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### url

```
USAGE
  linear issue url [flags] [<identifier>]

ARGUMENTS
  identifier string     (optional)

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### describe

```
USAGE
  linear issue describe [flags] [<identifier>]

ARGUMENTS
  identifier string     (optional)

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### commits

```
USAGE
  linear issue commits [flags] [<identifier>]

ARGUMENTS
  identifier string     (optional)

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### pull-request

```
USAGE
  linear issue pull-request [flags] [<identifier>]

ARGUMENTS
  identifier string     (optional)

FLAGS
  --draft          
  --base string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### comment

```
USAGE
  linear issue comment <subcommand> [flags]

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level

SUBCOMMANDS
  add       
  list      
  update    
  delete
```

#### comment subcommands

##### add

```
USAGE
  linear issue comment add [flags] <identifier> <body>

ARGUMENTS
  identifier string    
  body string          

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

##### list

```
USAGE
  linear issue comment list [flags] <identifier>

ARGUMENTS
  identifier string    

FLAGS
  --json    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

##### update

```
USAGE
  linear issue comment update [flags] <comment-id> <body>

ARGUMENTS
  comment-id string    
  body string          

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

##### delete

```
USAGE
  linear issue comment delete [flags] <comment-id>

ARGUMENTS
  comment-id string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### attach

```
USAGE
  linear issue attach [flags] <identifier> <url>

ARGUMENTS
  identifier string    
  url string           

FLAGS
  --title string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### link

```
USAGE
  linear issue link [flags] <identifier> <url>

ARGUMENTS
  identifier string    
  url string           

FLAGS
  --title string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

### relation

```
USAGE
  linear issue relation <subcommand> [flags]

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level

SUBCOMMANDS
  add       
  list      
  delete
```

#### relation subcommands

##### add

```
USAGE
  linear issue relation add [flags] <identifier> <related-identifier>

ARGUMENTS
  identifier string        
  related-identifier string

FLAGS
  --type string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

##### list

```
USAGE
  linear issue relation list [flags] <identifier>

ARGUMENTS
  identifier string    

FLAGS
  --json    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```

##### delete

```
USAGE
  linear issue relation delete [flags] <relation-id>

ARGUMENTS
  relation-id string    

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level
```
